import * as Y from "yjs";
import * as binary from "lib0/binary";
import * as promise from "lib0/promise";
import { Buffer } from "buffer";
import { MongoAdapter } from "./mongo-adapter";
import * as U from "./utils";

export class MongodbPersistence {
	/**
	 * Create a y-mongodb persistence instance.
	 * @param {string} location
	 * @param {object} [opts.collectionName = "yjs-writings", opts.flushSize = 400, opts.multipleCollections = false]
	 */
	constructor(location, options) {
		const db = new MongoAdapter(location, {
			collection: options?.collectionName ?? "yjs-writings",
			multipleCollections: !!options?.multipleCollections,
		});
		this.flushSize = options?.flushSize ?? U.PREFERRED_TRIM_SIZE;
		this.multipleCollections = !!options?.multipleCollections;

		// scope the queue of the transaction to each docName
		// -> this should allow concurrency for different rooms
		// Idea and adjusted code from: https://github.com/fadiquader/y-mongodb/issues/10
		this.tr = {};

		/**
		 * Execute an transaction on a database. This will ensure that other processes are currently not writing.
		 *
		 * This is a private method and might change in the future.
		 *
		 * @template T
		 *
		 * @param {function(any):Promise<T>} f A transaction that receives the db object
		 * @return {Promise<T>}
		 */
		this._transact = (docName, f) => {
			if (!this.tr[docName]) {
				this.tr[docName] = promise.resolve();
			}

			const currTr = this.tr[docName];

			this.tr[docName] = (async () => {
				await currTr;

				let res = /** @type {any} */ (null);
				try {
					res = await f(db);
				} catch (err) {
					console.warn("Error during saving transaction", err);
				}
				return res;
			})();
			return this.tr[docName];
		};
	}

	/**
	 * Create a Y.Doc instance with the data persistet in mongodb. Use this to temporarily create a Yjs document to sync changes or extract data.
	 *
	 * @param {string} docName
	 * @return {Promise<Y.Doc>}
	 */
	getYDoc(docName) {
		return this._transact(docName, async db => {
			const updates = await U.getMongoUpdates(db, docName);
			const ydoc = new Y.Doc();
			ydoc.transact(() => {
				for (let i = 0; i < updates.length; i++) {
					Y.applyUpdate(ydoc, updates[i]);
				}
			});
			if (updates.length > this.flushSize) {
				await U.flushDocument(db, docName, Y.encodeStateAsUpdate(ydoc), Y.encodeStateVector(ydoc));
			}
			return ydoc;
		});
	}

	/**
	 * Store a single document update to the database.
	 *
	 * @param {string} docName
	 * @param {Uint8Array} update
	 * @return {Promise<number>} Returns the clock of the stored update
	 */
	storeUpdate(docName, update) {
		return this._transact(docName, db => U.storeUpdate(db, docName, update));
	}

	/**
	 * The state vector (describing the state of the persisted document - see https://github.com/yjs/yjs#Document-Updates) is maintained in a separate field and constantly updated.
	 *
	 * This allows you to sync changes without actually creating a Yjs document.
	 *
	 * @param {string} docName
	 * @return {Promise<Uint8Array>}
	 */
	getStateVector(docName) {
		return this._transact(docName, async db => {
			const { clock, sv } = await U.readStateVector(db, docName);
			let curClock = -1;
			if (sv !== null) {
				curClock = await U.getCurrentUpdateClock(db, docName);
			}
			if (sv !== null && clock === curClock) {
				return sv;
			} else {
				// current state vector is outdated
				const updates = await U.getMongoUpdates(db, docName);
				const { update, sv } = U.mergeUpdates(updates);
				await U.flushDocument(db, docName, update, sv);
				return sv;
			}
		});
	}

	/**
	 * Get the differences directly from the database.
	 * The same as Y.encodeStateAsUpdate(ydoc, stateVector).
	 * @param {string} docName
	 * @param {Uint8Array} stateVector
	 */
	async getDiff(docName, stateVector) {
		const ydoc = await this.getYDoc(docName);
		return Y.encodeStateAsUpdate(ydoc, stateVector);
	}

	/**
	 * Delete a document, and all associated data from the database.
	 * @param {string} docName
	 * @return {Promise<void>}
	 */
	clearDocument(docName) {
		return this._transact(docName, async db => {
			await db.del(U.createDocumentStateVectorKey(docName));
			await U.clearUpdatesRange(db, docName, 0, binary.BITS32);
		});
	}

	/**
	 * Persist some meta information in the database and associate it with a document. It is up to you what you store here. You could, for example, store credentials here.
	 *
	 * Unlike y-leveldb, we simply store the value here without encoding it in a buffer beforehand.
	 * @param {string} docName
	 * @param {string} metaKey
	 * @param {any} value
	 * @return {Promise<void>}
	 */
	setMeta(docName, metaKey, value) {
		return this._transact(docName, async db => {
			await db.put(U.createDocumentMetaKey(docName, metaKey), { value });
		});
	}

	/**
	 * Retrieve a store meta value from the database. Returns undefined if the metaKey doesn't exist.
	 * @param {string} docName
	 * @param {string} metaKey
	 * @return {Promise<any>}
	 */
	getMeta(docName, metaKey) {
		return this._transact(docName, async db => {
			const res = await db.get({ ...U.createDocumentMetaKey(docName, metaKey) });
			if (!res?.value) {
				return; // return void
			}
			return res.value;
		});
	}

	/**
	 * Delete a store meta value.
	 * @param {string} docName
	 * @param {string} metaKey
	 * @return {Promise<any>}
	 */
	delMeta(docName, metaKey) {
		return this._transact(docName, db => db.del({ ...U.createDocumentMetaKey(docName, metaKey) }));
	}

	/**
	 * Retrieve the names of all stored documents.
	 * @return {Promise<Array<string>>}
	 */
	getAllDocNames() {
		return this._transact("global", async db => {
			if (this.multipleCollections) {
				// get all collection names from db
				return await db.getCollectionNames();
			} else {
				// when all docs are stored in the same collection we just need to get all
				//  statevectors and return their names
				const docs = await U.getAllSVDocs(db);
				return docs.map(doc => doc.docName);
			}
		});
	}

	/**
	 * Retrieve the state vectors of all stored documents. You can use this to sync two y-leveldb instances.
	 * !Note: The state vectors might be outdated if the associated document is not yet flushed. So use with caution.
	 * @return {Promise<Array<{ name: string, sv: Uint8Array, clock: number }>>}
	 * @todo funktioniert nicht
	 */
	getAllDocStateVectors() {
		return this._transact("global", async db => {
			const docs = await U.getAllSVDocs(db);
			return docs.map(doc => {
				const { sv, clock } = U.decodeMongodbStateVector(doc.value);
				return { name: doc.docName, sv, clock };
			});
		});
	}

	/**
	 * Internally y-mongodb stores incremental updates. You can merge all document updates to a single entry. You probably never have to use this.
	 * It is done automatically every 400 transactions.
	 *
	 * @param {string} docName
	 * @return {Promise<void>}
	 */
	flushDocument(docName) {
		return this._transact(docName, async db => {
			const updates = await U.getMongoUpdates(db, docName);
			const { update, sv } = U.mergeUpdates(updates);
			await U.flushDocument(db, docName, update, sv);
		});
	}

	/**
	 * Delete the whole yjs mongodb
	 */
	flushDB() {
		return this._transact("global", async db => {
			await U.flushDB(db);
		});
	}
}