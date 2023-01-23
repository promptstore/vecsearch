const Minio = require('minio');
const algoliasearch = require('algoliasearch');
const bodyParser = require('body-parser');
const express = require('express');
const expressWinston = require('express-winston');
const fs = require('fs');
const multer = require('multer');
const os = require('os');
const uuid = require('node-uuid');
const winston = require('winston');
const { parse } = require('csv-parse');
const { createClient, SchemaFieldTypes } = require('redis');

require('dotenv').config();

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.splat(),
    winston.format.simple(),
  ),
  transports: [
    new winston.transports.Console(),
  ],
});

logger.log('info', 'environment is "%s"', process.env.NODE_ENV);

const rc = createClient({
  host: process.env.REDIS_HOST,
});

rc.connect();

const mc = new Minio.Client({
  endPoint: process.env.S3_ENDPOINT,
  port: parseInt(process.env.S3_PORT, 10),
  useSSL: false,
  accessKey: process.env.AWS_ACCESS_KEY,
  secretKey: process.env.AWS_SECRET_KEY,
});

const algolia = algoliasearch('***REMOVED***', '***REMOVED***');
const index = algolia.initIndex('instant_search');

const constants = {
  'FILE_BUCKET': process.env.FILE_BUCKET,
};

const upload = multer({ dest: os.tmpdir() });

const app = express();
const port = process.env.PORT || 5000;

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

app.listen(port, () => { logger.log('info', 'Listening on port %s', port); });

app.get('/', (req, res) => {
  res.send('Hello from vecsearch');
});

app.get('/api/search', async (req, res) => {
  logger.log('debug', 'params: ', req.query);
  const { indexName, q } = req.query;
  try {
    const result = await rc.ft.search(
      'idx:' + indexName,
      q
    );
    const hits = result.documents.map((x) => x.value);
    res.json(hits);
  } catch (e) {
    logger.log('error', '%s\n%s', e, e.stack);
    res.status(500).json({
      error: String(e),
    });
  }
});

app.post('/api/index', async (req, res) => {
  const { fields, indexName } = req.body;
  try {
    const prefix = 'vs:' + indexName;
    const schema = Object.entries(fields).reduce((a, [k, v]) => {
      a[k] = {
        type: getType(v.type),
        sortable: !!v.sortable,
      };
      return a;
    }, {});
    schema['__uid'] = {
      type: 'TAG',
    };
    logger.log('debug', 'schema: ', schema);

    // await rc.connect();

    await rc.ft.create('idx:' + indexName, schema, {
      ON: 'HASH',
      PREFIX: prefix,
    });
    res.json({
      status: 'OK',
    });
  } catch (e) {
    if (e.message === 'Index already exists') {
      logger.log('error', 'Index exists already, skipped creation.');
    } else {
      // Something went wrong, perhaps RediSearch isn't installed...
      logger.log('error', '%s\n%s', e, e.stack);
    }
    res.status(500).json({
      error: String(e),
    });
  } finally {
    // logger.log('debug', 'Disconnecting redis client');
    // await rc.disconnect;
  }
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  const { indexName } = req.body;
  logger.log('debug', 'indexName: %s', indexName);
  const file = req.file;
  logger.log('debug', 'file: ', file);
  try {

    // await rc.connect();

    const metadata = {
      'Content-Type': file.mimetype,
    };
    const objectName = `${indexName}/${file.originalname}`;
    mc.fPutObject(constants.FILE_BUCKET, objectName, file.path, metadata, async (err, etag) => {
      if (err) {
        return logger.error(err);
      }
      logger.log('info', 'File uploaded successfully.');

      const index = await rc.ft.info('idx:' + indexName);
      const fields = index.attributes.reduce((a, x) => {
        a[x.attribute] = {
          type: x.type,
          sortable: x.sortable,
        };
        return a;
      }, {});

      const prefix = 'vs:' + indexName;

      let headers;

      const addData = (row) => {
        const data = headers.reduce((a, h, i) => {
          const field = fields[h];
          if (field) {
            if (field.type === 'NUMERIC') {
              a[h] = parseMaybeCurrency(row[i]);
            } else {
              a[h] = row[i].replace(/[^\w\s-]/gi, '');
            }
          }
          return a;
        }, {});
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
      error: String(e),
    });
  } finally {
    // logger.log('debug', 'Disconnecting redis client');
    // await rc.disconnect;
  }
});

app.post('/api/search/:indexName', async (req, res, next) => {
  const { indexName } = req.params;
  logger.log('debug', 'indexName: %s', indexName);
  const { requests } = req.body;
  logger.log('debug', 'requests: ', requests);
  logger.log('debug', 'query: %s', requests[0].params.query);
  // const result = await index.search(requests[0].params.query);
  const rawResult = await rc.ft.search(
    'idx:' + indexName,
    requests[0].params.query
  );
  logger.log('debug', 'rawResult: ', rawResult);
  const result = formatAlgolia(requests, rawResult);
  res.json({ results: [result] });
});

const formatAlgolia = (requests, rawResult) => {
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

const getType = (type) => {
  switch (type) {
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
  if (typeof value === 'string') {
    return Number(value.replace(/[^0-9.-]+/g, ''));
  }
  return value;
};
