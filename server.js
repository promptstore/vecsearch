const Minio = require('minio');
const bodyParser = require('body-parser');
const express = require('express');
const expressWinston = require('express-winston');
const fs = require('fs');
const multer = require('multer');
const os = require('os');
const uuid = require('node-uuid');
const winston = require('winston');
const { parse } = require('csv-parse');
const { createClient, SchemaFieldTypes, VectorAlgorithms } = require('redis');

require('@tensorflow/tfjs-node');
const use = require('@tensorflow-models/universal-sentence-encoder');

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const logger = require('./logger');

const INDEX_NAME_PREFIX = 'idx';

logger.log('info', 'environment is "%s"', process.env.NODE_ENV);
logger.log('info', 'redis host is "%s"', process.env.REDIS_HOST);

const rc = createClient({
  url: `redis://${process.env.REDIS_HOST}:6379`,
  password: process.env.REDIS_PASSWORD,
});

rc.connect().catch((err) => {
  logger.log('error', err);
  process.exit(1);
});

const mc = new Minio.Client({
  endPoint: process.env.S3_ENDPOINT,
  port: parseInt(process.env.S3_PORT, 10),
  useSSL: false,
  accessKey: process.env.AWS_ACCESS_KEY,
  secretKey: process.env.AWS_SECRET_KEY,
});

const constants = {
  'FILE_BUCKET': process.env.FILE_BUCKET,
};

const upload = multer({ dest: os.tmpdir() });

const app = express();
const port = process.env.PORT || 5002;

const assignId = (req, res, next) => {
  req.id = uuid.v4();
  next();
};

app.use(assignId);

app.use(expressWinston.logger({
  transports: [
    new winston.transports.Console(),
  ],
  format: winston.format.combine(
    winston.format.splat(),
    winston.format.simple(),
  ),
  meta: false,
  msg: 'HTTP  ',
  expressFormat: true,
  colorize: false,
  ignoreRoute: (req, res) => { return false; },
}));

app.use(bodyParser.json({ limit: '25mb' }));

let __model;

logger.log('debug', 'Loading model...');
use.load()
  .then((model) => {
    __model = model;
    logger.log('debug', 'Model loaded!');

    app.listen(port, '0.0.0.0', () => { logger.log('info', 'Listening on port', port); });

  })
  .catch((err) => {
    logger.log('error', err, err.stack);
  });

app.get('/', (req, res) => {
  res.send('Hello from vecsearch');
});

app.post('/api/embeddings', async (req, res) => {
  let { text } = req.body;
  if (!Array.isArray(text)) {
    text = [text];
  }
  logger.debug('text:', text);
  const embeddings = [];
  let i = 0;
  for (const t of text) {
    if (t) {
      const embedding = await getEmbedding(text);
      embeddings.push({
        index: i,
        object: 'embedding',
        embedding,
      });
    }
    i += 1;
  }
  res.json(embeddings);
});

const search = async (indexName, q, rest, logicalType = 'and', limit = 10, getParents = false) => {
  logger.log('debug', 'q:', q);
  const name = `${INDEX_NAME_PREFIX}:${indexName}`;
  const index = await rc.ft.info(name);
  // logger.log('debug', 'index:', index);
  const fields = index.attributes.reduce((a, x) => {
    a[x.attribute] = {
      type: x.type,
      sortable: x.sortable,
    };
    return a;
  }, {});
  logger.log('debug', 'fields:', fields);
  logger.log('debug', 'rest:', rest);
  const attrs = [];
  for (const [k, v] of Object.entries(rest)) {
    const field = fields[k];
    if (field) {
      const type = field.type;
      if (type === 'NUMERIC') {
        attrs.push(`@${k}:[${v} ${v}]`);
      } else if (type === 'TAG') {
        attrs.push(`@${k}:{${v}}`);
      } else {
        attrs.push(`@${k}:${v}`);
      }
    }
  }
  logger.debug('attrs:', attrs);
  const vectorField = Object.entries(fields).find(([k, v]) => v.type === 'VECTOR');
  // logger.debug('vectorField:', vectorField);
  let query, result;
  if (q && vectorField) {
    const queryEmbedding = await getEmbedding(q);
    // logger.debug('query embedding:', float32Buffer(queryEmbedding));
    if (attrs.length) {
      if (logicalType === 'or') {
        query = `(${attrs.map(a => `(${a})`).join(' | ')})`;
      } else {
        query = `(${attrs.join(' ')})`;
      }
    } else {
      query = '*';
    }
    query += `=>[KNN ${limit} @${vectorField[0]} $BLOB as dist]`;
    logger.log('debug', 'query:', query);
    const returnFields = Object.keys(fields).filter((f) => f !== vectorField[0]);
    result = await rc.ft.search(
      name,
      query,
      {
        PARAMS: {
          BLOB: float32Buffer(queryEmbedding),
        },
        // ascending because we want the closest items
        SORTBY: {
          BY: 'dist',
        },
        DIALECT: 2,
        RETURN: [...returnFields, 'dist']
      }
    );
  } else if (q) {
    query = q;
    if (attrs.length) {
      if (logicalType === 'or') {
        query += ` (${attrs.map(a => `(${a})`).join(' | ')})`;
      } else {
        query += ' ' + attrs.join(' ');
      }
    }
    logger.log('debug', 'query:', query);
    result = await rc.ft.search(
      name,
      query
    );
  } else if (attrs.length) {
    query += attrs.join(' ');
    logger.log('debug', 'query:', query);
    result = await rc.ft.search(
      name,
      query
    );
  }

  if (!result) {
    return [];
  }
  const hits = result.documents.map((x) => x.value);
  logger.log('debug', 'hits:', hits);
  hits.sort((a, b) => parseFloat(a.dist) < parseFloat(b.dist) ? -1 : 1);

  if (getParents) {
    const proms = hits.flatMap(hit => getParentDocs(indexName, hit));
    const docs = await Promise.all(proms);
    return docs.map(d => d[0]).slice(0, limit);
  }

  return hits;
};

const getParentDocs = async (indexName, hit) => {
  logger.debug('hit:', hit);
  if (!hit.content_parent_uids) {
    return [];
  }
  const prefix = 'vs:' + indexName;
  const docs = [];
  const parent_uids = hit.content_parent_uids.split(',');
  for (const parent_uid of parent_uids) {
    const itemsStr = await rc.hGet(`${prefix}:parent:${parent_uid}`, 'items');
    const items = itemsStr.split(',');
    const proms = items.map(uid => rc.hGetAll(`${prefix}:${uid}`));
    const chunks = await Promise.all(proms);
    // logger.debug('chunks:', chunks);
    docs.push({ uid: parent_uid, chunks: removeVectorFieldsFromSearchResults(chunks) });
  }
  return docs;
};

const parseFloat = (val) => {
  try {
    const f = parseFloat(val);
    return f;
  } catch (err) {
    return 0;
  }
};

const removeVectorFieldsFromSearchResults = (hits) => {
  return hits.map((h) => {
    return Object.entries(h).reduce((a, [k, v]) => {
      if (!k.endsWith('_vec')) {
        a[k] = v;
      }
      return a;
    }, {});
  });
};

const parseObjectValues = (hits) => {
  return hits.map((h) => {
    return Object.entries(h).reduce((a, [k, v]) => {
      if (v && typeof v === 'string' && ['{', '[', '"'].includes(v.charAt(0))) {
        try {
          a[k] = JSON.parse(v);
        } catch (err) {
          a[k] = v;
        }
      } else {
        a[k] = v;
      }
      return a;
    }, {});
  });
};

app.get('/api/search', async (req, res) => {
  logger.log('debug', 'params: ', req.query);
  const { indexName, q, logicalType, limit, getParents, ...rest } = req.query;
  try {
    const hits = await search(indexName, q, rest, logicalType, limit, getParents);
    // logger.log('debug', 'hits:', hits);
    let cleaned = removeVectorFieldsFromSearchResults(hits);
    cleaned = parseObjectValues(cleaned);
    logger.log('debug', 'cleaned:', cleaned);
    res.json(cleaned);
  } catch (e) {
    logger.log('error', '%s\n%s', e, e.stack);
    res.status(500).json({
      error: { message: String(e) },
    });
  }
});

app.get('/api/index', async (req, res) => {
  try {
    const indexes = await rc.ft._list();
    res.json(indexes);
  } catch (e) {
    logger.log('error', '%s\n%s', e, e.stack);
    res.status(500).json({
      error: { message: String(e) },
    });
  }
});

app.get('/api/index/:name', async (req, res) => {
  const { name } = req.params;
  logger.debug('Get index with name:', name);
  try {
    const index = await rc.ft.info(`${INDEX_NAME_PREFIX}:${name}`);
    res.json(index);
  } catch (e) {
    logger.log('error', '%s\n%s', e, e.stack);
    res.status(500).json({
      error: { message: String(e) },
    });
  }
});

app.put('/api/index', async (req, res) => {
  const { fields, indexName } = req.body;
  try {
    const schema = getSchema(fields);
    await rc.ft.alter(`${INDEX_NAME_PREFIX}:${indexName}`, schema);
    res.sendStatus(200);
  } catch (e) {
    logger.log('error', '%s\n%s', e, e.stack);
    res.status(500).json({
      error: { message: String(e) },
    });
  }
});

app.post('/api/index', async (req, res) => {
  logger.log('debug', 'body: ', req.body);
  const { fields, indexName } = req.body;
  try {
    const prefix = 'vs:' + indexName;
    const schema = getSchema(fields);
    logger.log('debug', 'schema: ', schema);

    const name = `${INDEX_NAME_PREFIX}:${indexName}`;
    await rc.ft.create(name, schema, {
      ON: 'HASH',
      PREFIX: prefix,
    });
    const index = await rc.ft.info(name);
    res.json(index);
  } catch (e) {
    if (e.message === 'Index already exists') {
      logger.log('error', 'Index already exists, skipped creation.');
      res.status(400).json({
        error: { message: e.message },
      });
    } else {
      // Something went wrong, perhaps RediSearch isn't installed...
      logger.log('error', '%s\n%s', e, e.stack);
      res.status(500).json({
        error: { message: String(e) },
      });
    }
  } finally {
    logger.log('debug', 'Disconnecting redis client');
  }
});

app.delete('/api/index/:name', async (req, res) => {
  const { name } = req.params;
  try {
    await rc.ft.dropIndex(`${INDEX_NAME_PREFIX}:${name}`);
    res.json({ status: 'OK' });
  } catch (e) {
    logger.log('error', '%s\n%s', e, e.stack);
    res.status(500).json({
      error: { message: String(e) },
    });
  }
});

function deleteKeysByPattern(pattern) {
  (async (match) => {
    for await (const key of rc.scanIterator({ MATCH: match })) {
      await rc.del(key);
    }
  })(pattern);
}

app.delete('/api/index/:name/data', async (req, res) => {
  const { name } = req.params;
  try {
    const pattern = 'vs:' + name + ':*';
    logger.log('debug', 'deleting pattern: %s', pattern);
    deleteKeysByPattern(pattern);
    res.json({ status: 'OK' });
  } catch (e) {
    logger.log('error', '%s\n%s', e, e.stack);
    res.status(500).json({
      error: { message: String(e) },
    });
  }
});

app.post('/api/parent-documents', async (req, res) => {
  const { indexName, parentDocuments } = req.body;
  const prefix = 'vs:' + indexName;
  try {
    for (const parent of parentDocuments) {
      // logger.debug('parent doc:', parent);
      const data = {
        uid: parent.uid,
        items: parent.items.join(','),
      };
      await rc.hSet(`${prefix}:parent:${parent.uid}`, data);
    }
    res.sendStatus(200);
  } catch (e) {
    logger.log('error', '%s\n%s', e, e.stack);
    res.status(500).json({
      error: { message: String(e) },
    });
  }
});

app.post('/api/document', async (req, res) => {
  const { documents, indexName, nodeLabel } = req.body;
  logger.log('debug', 'indexName: %s', indexName);
  logger.log('debug', 'documents: %s', JSON.stringify(documents, null, 2));
  const prefix = 'vs:' + indexName;
  try {
    const fields = await getIndexFields(indexName);
    const fieldNames = Object.keys(fields);
    logger.log('debug', 'fields:', fields);
    logger.log('debug', 'fieldNames:', fieldNames);
    for (const document of documents) {
      logger.log('debug', 'document:', document);
      const documentKeys = Object.keys(document);
      const data = {};
      logger.log('debug', 'documentKeys:', documentKeys);
      for (let j = 0; j < fieldNames.length; j++) {
        const name = fieldNames[j];
        const field = fields[name];
        for (let i = 0; i < documentKeys.length; i++) {
          const k = documentKeys[i];
          const v = document[k];
          if (field.type === 'VECTOR' && name.slice(0, -4) === k.replace(/\./g, '__')) {
            const embedding = await getEmbedding(v);
            data[name] = float32Buffer(embedding);
            break;
          } else if (name === k.replace(/\./g, '__') && v !== null) {
            if (Array.isArray(v)) {
              data[name] = v.join(',');
            } else if (field.type === 'NUMERIC') {
              data[name] = parseMaybeCurrency(v);
            } else if (typeof v === 'boolean') {
              data[name] = String(v);
            } else {
              data[name] = v;
            }
            break;
          }
        }
      }
      // const uid = data.content_uid || uuid.v4();
      // data['__uid'] = uid;
      logger.log('debug', 'data: %s', data);
      const id = document[nodeLabel + '.id'];
      await rc.hSet(`${prefix}:${id}`, data);
    }
    res.sendStatus(200);
  } catch (e) {
    logger.log('error', '%s\n%s', e, e.stack);
    res.status(500).json({
      error: { message: String(e) },
    });
  }
});

app.delete('/api/indexes/:indexName/documents/:uid', async (req, res) => {
  const { indexName, uid } = req.params;
  const prefix = 'vs:' + indexName;
  try {
    await rc.del(`${prefix}:${uid}`);
    res.sendStatus(200);
  } catch (e) {
    logger.log('error', '%s\n%s', e, e.stack);
    res.status(500).json({
      error: { message: String(e) },
    });
  }
});

app.post('/api/bulk-delete', async (req, res) => {
  const { indexName, uids } = req.body;
  const prefix = 'vs:' + indexName;
  try {
    const promises = uids.map((uid) => rc.del(`${prefix}:${uid}`));
    await Promise.all(promises);
    res.sendStatus(200);
  } catch (e) {
    logger.log('error', '%s\n%s', e, e.stack);
    res.status(500).json({
      error: { message: String(e) },
    });
  }
});

app.delete('/api/delete-matching', async (req, res) => {
  const { indexName, q, ...rest } = req.query;
  const prefix = 'vs:' + indexName;
  try {
    const hits = await search(indexName, q, rest);
    const uids = hits.map(h => h.uid);
    const promises = uids.map((uid) => rc.del(`${prefix}:${uid}`));
    await Promise.all(promises);
    res.sendStatus(200);
  } catch (e) {
    logger.log('error', '%s\n%s', e, e.stack);
    res.status(500).json({
      error: { message: String(e) },
    });
  }
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  const { indexName } = req.body;
  logger.log('debug', 'indexName: %s', indexName);
  const file = req.file;
  logger.log('debug', 'file: ', file);
  try {
    const metadata = {
      'Content-Type': file.mimetype,
    };
    const objectName = `${indexName}/${file.originalname}`;
    mc.fPutObject(constants.FILE_BUCKET, objectName, file.path, metadata, async (err, etag) => {
      if (err) {
        return logger.error(err);
      }
      logger.log('info', 'File uploaded successfully.');

      const fields = await getIndexFields(indexName);
      logger.log('debug', 'fields: ', fields);
      const fieldNames = Object.keys(fields);
      const prefix = 'vs:' + indexName;

      let headers;

      const addData = async (row) => {
        const data = {};
        for (let j = 0; j < fieldNames.length; j++) {
          const name = fieldNames[j];
          const field = fields[name];
          for (let i = 0; i < headers.length; i++) {
            const h = headers[i];
            if (field.type === 'VECTOR' && name.slice(0, -4) === h) {
              const embeddings = await getEmbedding(row[i]);
              data[name] = float32Buffer(embeddings);
              break;
            } else if (name === h) {
              if (field.type === 'NUMERIC') {
                data[name] = parseMaybeCurrency(row[i]);
              } else if (typeof v === 'boolean') {
                data[name] = String(v);
              } else {
                data[name] = row[i];
              }
              break;
            }
          }
        }
        const uid = uuid.v4();
        data['__uid'] = uid;
        return rc.hSet(`${prefix}:${uid}`, data);
      };

      const promises = [];
      fs.createReadStream(file.path)
        .pipe(parse({ delimiter: ',' }))
        .on('data', (row) => {
          if (!headers) {
            headers = row;
          } else {
            promises.push(addData(row));
          }
        })
        .on('end', async () => {
          await Promise.all(promises).catch((err) => {
            logger.log('error', String(err));
          });
          res.json({
            status: 'OK',
          });
        });

    });
  } catch (e) {
    logger.log('error', '%s\n%s', e, e.stack);
    res.status(500).json({
      error: { message: String(e) },
    });
  } finally {
    logger.log('debug', 'Disconnecting redis client');
  }
});

app.post('/api/search/:indexName', async (req, res, next) => {
  const { indexName } = req.params;
  logger.log('debug', 'indexName: %s', indexName);
  const { requests } = req.body;
  logger.log('debug', 'requests: ', requests);
  logger.log('debug', 'query: %s', requests[0].params.query);
  const rawResult = await rc.ft.search(
    `${INDEX_NAME_PREFIX}:${indexName}`,
    requests[0].params.query
  );
  logger.log('debug', 'rawResult: ', rawResult);
  const result = formatAlgoliaResponse(requests, rawResult);
  res.json({ results: [result] });
});

const formatAlgoliaResponse = (requests, rawResult) => {
  const documents = rawResult.documents;
  const nbHits = documents.length;
  const hits = documents.map((doc) => doc.value).map((val) => ({
    name: val.product_name,
    description: val.technical_details,
  }));
  return {
    exhaustive: {
      nbHits: true,
      typo: true,
    },
    exhaustiveNbHits: true,
    exhaustiveType: true,
    hits,
    hitsPerPage: nbHits,
    nbHits,
    nbPages: 1,
    page: 0,
    params: '',
    processingTimeMS: 2,
    processingTimingsMS: {
      afterFetch: {
        format: {
          highlighting: 2,
          total: 2,
        },
        total: 2,
      },
      request: {
        roundTrip: 19,
      },
      total: 2,
    },
    query: requests[0].params.query,
    renderingContent: {},
    serverTimeMS: 3,
  };
};

const float32Buffer = (arr) => {
  return Buffer.from(new Float32Array(arr).buffer);
};

const getEmbedding = async (text) => {
  const model = await getModel();
  if (!Array.isArray(text)) {
    text = [text];
  }
  const embeddings = await model.embed(text);
  const values = embeddings.dataSync();
  return Array.from(values);
};

const getIndexFields = async (indexName) => {
  const index = await rc.ft.info(`${INDEX_NAME_PREFIX}:${indexName}`);
  const fields = index.attributes.reduce((a, x) => {
    a[x.attribute] = {
      type: x.type,
      sortable: x.sortable,
    };
    return a;
  }, {});
  return fields;
};

const getModel = async () => {
  if (!__model) {
    logger.log('debug', 'Loading model...');
    try {
      __model = await use.load();
    } catch (err) {
      logger.log('error', err);
    }
    logger.log('debug', 'Model loaded!');
  }
  return __model;
};

const getSchema = (fields) => {
  return Object.entries(fields).reduce((a, [k, v]) => {
    const key = k.replace(/\./g, '__');
    const type = getType(v.type);
    if (v.type === 'VECTOR') {
      a[key] = {
        type: SchemaFieldTypes.TEXT,
        sortable: !!v.sortable,
      };
      a[key + '_vec'] = {
        type,
        ALGORITHM: VectorAlgorithms.HNSW,
        TYPE: 'FLOAT32',
        DIM: 512,
        DISTANCE_METRIC: 'L2',
      };
    } else {
      a[key] = {
        type,
        sortable: !!v.sortable,
      };
    }
    return a;
  }, {});
};

const getType = (type) => {
  switch (type) {
    case 'VECTOR':
      return SchemaFieldTypes.VECTOR;

    case 'TEXT':
      return SchemaFieldTypes.TEXT;

    case 'TAG':
      return SchemaFieldTypes.TAG;

    case 'NUMERIC':
      return SchemaFieldTypes.NUMERIC;

    default:
      return SchemaFieldTypes.TEXT;
  }
};

const parseMaybeCurrency = (value) => {
  let num = value;
  if (value && typeof value === 'string') {
    num = Number(value.replace(/[^0-9.-]+/g, ''));
  }
  return isNaN(num) ? 0 : num;
};
