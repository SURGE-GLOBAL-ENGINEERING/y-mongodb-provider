import * as Y from 'yjs';
import * as binary from 'lib0/binary';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { Buffer } from 'buffer';
import { MongoBulkWriteError, MongoNetworkError, MongoNetworkTimeoutError } from 'mongodb';

export const PREFERRED_TRIM_SIZE = 400;
const MAX_DOCUMENT_SIZE = 15000000; // ~15MB (plus space for metadata)

/**
 * Remove all documents from db with Clock between $from and $to
 *
 * @param {import('./mongo-adapter.js').MongoAdapter} db
 * @param {string} docName
 * @param {number} from Greater than or equal
 * @param {number} to lower than (not equal)
 * @returns {Promise<import('mongodb').BulkWriteResult>} Contains status of the operation
 */
export const clearUpdatesRange = async (db, docName, from, to) =>
	db.delete({
		docName,
		clock: {
			$gte: from,
			$lt: to,
		},
	});

/**
 * Create a unique key for a update message.
 * @param {string} docName
 * @param {number} [clock] must be unique
 * @return {{version: "v1"; docName: string; action: "update"; clock?: number; }}
 */
const createDocumentUpdateKey = (docName, clock) => {
	if (clock !== undefined) {
		return {
			version: 'v1',
			action: 'update',
			docName,
			clock,
		};
	} else {
		return {
			version: 'v1',
			action: 'update',
			docName,
		};
	}
};

/**
 * We have a separate state vector key so we can iterate efficiently over all documents
 * @param {string} docName
 * @return {{docName: string; version: "v1_sv"}}
 */
export const createDocumentStateVectorKey = (docName) => ({
	docName,
	version: 'v1_sv',
});

/**
 * @param {string} docName
 * @param {string} metaKey
 * @return {{docName: string; version: "v1"; metaKey: string; }}
 */
export const createDocumentMetaKey = (docName, metaKey) => ({
	version: 'v1',
	docName,
	metaKey: `meta_${metaKey}`,
});

/**
 * @param {import('./mongo-adapter.js').MongoAdapter} db
 * @return {Promise<void>}
 */
export const flushDB = (db) => db.flush();

/**
 *
 * This function converts MongoDB updates to a buffer that can be processed by the application.
 * It handles both complete documents and large documents that have been split into smaller 'parts' due to MongoDB's size limit.
 * For split documents, it collects all the parts and merges them together.
 * It assumes that the parts of a split document are ordered and located exactly after the document with part number 1.
 *
 * @param {{ _id: import("mongodb").ObjectId; action: string; version: string; docName: string; clock: number; part?: number; value: import("mongodb").Binary; }[]} docs
 * @return {Uint8Array[]}
 */
const convertMongoUpdates = (docs) => {
	if (!Array.isArray(docs) || !docs.length) return [];

	/** @type {Uint8Array[]} */
	const updates = [];
	for (let i = 0; i < docs.length; i++) {
		const doc = docs[i];
		if (!doc.part) {
			updates.push(doc.value.buffer);
		} else if (doc.part === 1) {
			// merge the docs together that got split because of mongodb size limits
			const parts = [doc.value.buffer];
			let j;
			let currentPartId = doc.part;
			for (j = i + 1; j < docs.length; j++) {
				const part = docs[j];
				if (part.part && part.clock === doc.clock) {
					if (currentPartId !== part.part - 1) {
						throw new Error('Couldnt merge updates together because a part is missing!');
					}
					parts.push(part.value.buffer);
					currentPartId = part.part;
				} else {
					break;
				}
			}
			updates.push(Buffer.concat(parts));
			// set i to j - 1 because we already processed all parts
			i = j - 1;
		}
	}
	return updates;
};

/**
 * Get all document updates for a specific document.
 *
 * @param {import('./mongo-adapter.js').MongoAdapter} db
 * @param {string} docName
 * @return {Promise<Uint8Array[]>}
 */
export const getMongoUpdates = async (db, docName) => {
	const docs = await db.find(createDocumentUpdateKey(docName));
	// TODO: I dont know how to type this without actual typescript
	// @ts-ignore
	return convertMongoUpdates(docs);
};

/**
 * @param {import('./mongo-adapter.js').MongoAdapter} db
 * @param {string} docName
 * @return {Promise<number>} Returns -1 if this document doesn't exist yet
 */
export const getCurrentUpdateClock = (db, docName) =>
	db
		.findOne(
			{
				...createDocumentUpdateKey(docName, 0),
				clock: {
					$gte: 0,
					$lt: binary.BITS32,
				},
			},
			{ reverse: true },
		)
		.then((update) => {
			if (!update) {
				return -1;
			} else {
				return update.clock;
			}
		});

/**
 * @param {import('./mongo-adapter.js').MongoAdapter} db
 * @param {string} docName
 * @param {Uint8Array} sv state vector
 * @param {number} clock current clock of the document so we can determine
 * when this statevector was created
 */
const writeStateVector = async (db, docName, sv, clock) => {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, clock);
	encoding.writeVarUint8Array(encoder, sv);
	await db.put(createDocumentStateVectorKey(docName), {
		value: encoding.toUint8Array(encoder),
	});
};

/**
 * @param {import('./mongo-adapter.js').MongoAdapter} db
 * @param {string} docName
 * @param {Uint8Array} update
 * @return {Promise<number>} Returns the clock of the stored update
 */
export const storeUpdate = async (db, docName, update) => {
	const clock = await getCurrentUpdateClock(db, docName);
	if (clock === -1) {
		// make sure that a state vector is always written, so we can search for available documents
		const ydoc = new Y.Doc();
		Y.applyUpdate(ydoc, update);
		const sv = Y.encodeStateVector(ydoc);
		await writeStateVector(db, docName, sv, 0);
	}

	// mongodb has a maximum document size of 16MB;
	//  if our buffer exceeds it, we store the update in multiple documents
	if (update.length <= MAX_DOCUMENT_SIZE) {
		await db.put(createDocumentUpdateKey(docName, clock + 1), {
			value: update,
		});
	} else {
		const totalChunks = Math.ceil(update.length / MAX_DOCUMENT_SIZE);

		const putPromises = [];
		for (let i = 0; i < totalChunks; i++) {
			const start = i * MAX_DOCUMENT_SIZE;
			const end = Math.min(start + MAX_DOCUMENT_SIZE, update.length);
			const chunk = update.subarray(start, end);

			putPromises.push(
				db.put({ ...createDocumentUpdateKey(docName, clock + 1), part: i + 1 }, { value: chunk }),
			);
		}

		await Promise.all(putPromises);
	}

	return clock + 1;
};

/**
 * Encodes the state vector with the clock and the state vector Uint8Array.
 * @param {number} clock
 * @param {Uint8Array} sv
 * @return {Uint8Array}
 */
const encodeStateVector = (clock, sv) => {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, clock);
	encoding.writeVarUint8Array(encoder, sv);
	return encoding.toUint8Array(encoder);
};

/**
 * for network related and bulk write errors, retry connecting
 * can use to retry anyways, regardless of the error type
*/
const retryMongoOperation = async (task, retries = 3, delay = 1000) => {
	let lastError;
	for (let attempt = 1; attempt <= retries; attempt++) {
	  try {
		return await task();
	  } catch (error) {
		if (error instanceof MongoNetworkError || error instanceof MongoNetworkTimeoutError || error instanceof MongoBulkWriteError) {
		  lastError = error;
		  if (attempt < retries) {
			console.warn(`Attempt ${attempt} failed. Retrying in ${delay}ms`, error);
			await new Promise(res => setTimeout(res, delay));
		  } else {
			console.error("Final attempt failed:", error);
		  }
		} else {
		  throw error;
		}
	  }
	}
	throw lastError;
};

/**
 * @param {import('./mongo-adapter.js').MongoAdapter} db
 * @param {Object<string, Uint8Array>} updatesMap - Key-value pairs where the key is docName and the value is the update
 * @return {Promise<number>} Returns the clock of the stored update
 */
export const storeUpdates = async (db, updatesMap) => {
	let clock = -1; // for initial conversion

	/** @type {Record<string, { query: import('mongodb').Filter<import('mongodb').Document>, value: import('mongodb').UpdateFilter<import('mongodb').Document> }>} */
	const stateVectorMap = {};

	/** @type {Record<string, { query: import('mongodb').Filter<import('mongodb').Document>, value: import('mongodb').UpdateFilter<import('mongodb').Document> }>} */
	const updateMap = {};

	await Promise.all(
		Object.entries(updatesMap).map(async ([docName, update]) => {
			if (clock === -1) {
				// Ensure state vector is written
				const ydoc = new Y.Doc();
				Y.applyUpdate(ydoc, update);
				const sv = Y.encodeStateVector(ydoc);
				// await writeStateVector(db, docName, sv, 0);
				// Store state vector in stateVectorMap
				stateVectorMap[docName] = {
					query: createDocumentStateVectorKey(docName),
					value: {
						value: encodeStateVector(clock, sv),
					},
				};
			}

			if (update.length <= MAX_DOCUMENT_SIZE) {
				updateMap[docName] = {
					query: createDocumentUpdateKey(docName, clock + 1),
					value: {
						value: update,
					},
				};
			} else {
				const totalChunks = Math.ceil(update.length / MAX_DOCUMENT_SIZE);

				Array.from({ length: totalChunks }).forEach((_, i) => {
					const start = i * MAX_DOCUMENT_SIZE;
					const end = Math.min(start + MAX_DOCUMENT_SIZE, update.length);
					const chunk = update.subarray(start, end);

					updateMap[`${docName}-part${i + 1}`] = {
						query: { ...createDocumentUpdateKey(docName, clock + 1), part: i + 1 },
						value: {
							value: chunk,
						},
					};
				});
			}
		}),
	);

	// Use bulkPut method to store multiple documents in one operation with concurrency control
	const bulkWriteWithConcurrency = async (map, concurrencyLimit) => {
		const entries = Object.entries(map);
		const batchOperations = [];
		for (let i = 0; i < entries.length; i += concurrencyLimit) {
			const chunk = Object.fromEntries(entries.slice(i, i + concurrencyLimit));
			// const bulkWritePromise = db.bulkPut(chunk);
		  	const bulkWritePromise = retryMongoOperation(() => db.bulkPut(chunk), 3, 1000);
		  	batchOperations.push(bulkWritePromise);
		  	const delay = t => new Promise(resolve => setTimeout(resolve, t));
		  	//if limit reached, wait for current batch to finish
		  	if (batchOperations.length >= concurrencyLimit) {
				await Promise.all(batchOperations); //wait for current bulk operations
				batchOperations.length = 0; //reset batchOperations for next set of operations
				await delay(100);
		  	}
		}
		//execute remaining operations if exist
		if (batchOperations.length > 0) {
		  await Promise.all(batchOperations);
		}
	};

	const concurrencyLimit = 50;
	await Promise.all([
		bulkWriteWithConcurrency(stateVectorMap, concurrencyLimit),
		bulkWriteWithConcurrency(updateMap, concurrencyLimit)
	]);
	// await Promise.all([
	// 	await db.bulkPut(stateVectorMap),
	// 	await db.bulkPut(updateMap)
	// ]);

	return clock+1;
};

/**
 * @param {import('./mongo-adapter.js').MongoAdapter} db
 * @param {Object<string, Uint8Array>} updatesMap - Key-value pairs where the key is docName and the value is the update
 * @return {Promise<number>} Returns the clock of the stored update
 */
export const insertUpdates = async (db, updatesMap) => {
	let clock = -1; // for initial conversion

	/** @type {Record<string, { query: import('mongodb').Filter<import('mongodb').Document>, value: import('mongodb').UpdateFilter<import('mongodb').Document> }>} */
	const stateVectorMap = {};

	/** @type {Record<string, { query: import('mongodb').Filter<import('mongodb').Document>, value: import('mongodb').UpdateFilter<import('mongodb').Document> }>} */
	const updateMap = {};

	await Promise.all(
		Object.entries(updatesMap).map(async ([docName, update]) => {
			if (clock === -1) {
				// Ensure state vector is written
				const ydoc = new Y.Doc();
				Y.applyUpdate(ydoc, update);
				const sv = Y.encodeStateVector(ydoc);
				// await writeStateVector(db, docName, sv, 0);
				// Store state vector in stateVectorMap
				stateVectorMap[docName] = {
					query: createDocumentStateVectorKey(docName),
					value: {
						value: encodeStateVector(clock, sv),
					},
				};
			}

			if (update.length <= MAX_DOCUMENT_SIZE) {
				updateMap[docName] = {
					query: createDocumentUpdateKey(docName, clock + 1),
					value: {
						value: update,
					},
				};
			} else {
				const totalChunks = Math.ceil(update.length / MAX_DOCUMENT_SIZE);

				Array.from({ length: totalChunks }).forEach((_, i) => {
					const start = i * MAX_DOCUMENT_SIZE;
					const end = Math.min(start + MAX_DOCUMENT_SIZE, update.length);
					const chunk = update.subarray(start, end);

					updateMap[`${docName}-part${i + 1}`] = {
						query: { ...createDocumentUpdateKey(docName, clock + 1), part: i + 1 },
						value: {
							value: chunk,
						},
					};
				});
			}
		}),
	);

	await Promise.all([
		await retryMongoOperation(() => db.bulkInsert(stateVectorMap), 3, 1000),
		await retryMongoOperation(() => db.bulkInsert(updateMap), 3, 1000)
	]);

	return clock+1;
};

/**
 * For now this is a helper method that creates a Y.Doc and then re-encodes a document update.
 * In the future this will be handled by Yjs without creating a Y.Doc (constant memory consumption).
 *
 * @param {Array<Uint8Array>} updates
 * @return {{update:Uint8Array, sv: Uint8Array}}
 */
export const mergeUpdates = (updates) => {
	const ydoc = new Y.Doc();
	ydoc.transact(() => {
		for (let i = 0; i < updates.length; i++) {
			Y.applyUpdate(ydoc, updates[i]);
		}
	});
	return { update: Y.encodeStateAsUpdate(ydoc), sv: Y.encodeStateVector(ydoc) };
};

/**
 * @param {import("mongodb").Binary} buf
 * @return {{ sv: Uint8Array, clock: number }}
 */
export const decodeMongodbStateVector = (buf) => {
	let decoder;
	if (Buffer.isBuffer(buf)) {
		decoder = decoding.createDecoder(buf);
	} else if (Buffer.isBuffer(buf?.buffer)) {
		decoder = decoding.createDecoder(buf.buffer);
	} else {
		throw new Error('No buffer provided at decodeMongodbStateVector()');
	}
	const clock = decoding.readVarUint(decoder);
	const sv = decoding.readVarUint8Array(decoder);
	return { sv, clock };
};

/**
 * @param {import('./mongo-adapter.js').MongoAdapter} db
 * @param {string} docName
 */
export const readStateVector = async (db, docName) => {
	const doc = await db.findOne({ ...createDocumentStateVectorKey(docName) });
	if (!doc?.value) {
		// no state vector created yet or no document exists
		return { sv: null, clock: -1 };
	}
	return decodeMongodbStateVector(doc.value);
};

/**
 *
 * @param {import('./mongo-adapter.js').MongoAdapter} db
 */
export const getAllSVDocs = async (db) => db.find({ version: 'v1_sv' });

/**
 * Merge all MongoDB documents of the same yjs document together.
 * @param {import('./mongo-adapter.js').MongoAdapter} db
 * @param {string} docName
 * @param {Uint8Array} stateAsUpdate
 * @param {Uint8Array} stateVector
 * @return {Promise<number>} returns the clock of the flushed doc
 */
export const flushDocument = async (db, docName, stateAsUpdate, stateVector) => {
	const clock = await storeUpdate(db, docName, stateAsUpdate);
	await writeStateVector(db, docName, stateVector, clock);
	await clearUpdatesRange(db, docName, 0, clock);
	return clock;
};
