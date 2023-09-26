# vecsearch

Deployment:

    eval $(./export-env.sh .env)
    ./deploy.sh


Local Test:

    docker run -p 5002:5002 --net="host" --rm --env-file dev.env --name $app "${cr}/${app}:${ver}"


## Curl Examples

Create Schema

    curl -vL -H 'Content-Type: application/json' "http://localhost:5002/api/index" -d @fixtures/schemas/schema.json

    curl -vL -H 'Content-Type: application/json' "http://localhost:5002/api/index" -d @fixtures/schemas/agency_schema.json

Alter Schema

    curl -vL -X PUT -H 'Content-Type: application/json' "http://localhost:5002/api/index" -d @fixtures/schemas/schema_update.json


Batch Index Documents

    curl -vL -H 'Content-Type: multipart/form-data' -F 'file=@fixtures/data/amazon_products.csv' -F 'indexName=amazon_products' "http://localhost:5002/api/upload"


Add Document

    curl -vL -H 'Content-Type: application/json' "http://localhost:5002/api/document" -d @fixtures/documents/document.json


Search

    curl -vL "http://localhost:5002/api/search?q=ostrich&indexName=amazon_products" | jq

    curl -vL "http://localhost:5002/api/search?q=puppy&indexName=amazon_products" | jq

Redis Commands

`ft._list` - get list of indexes

bash: `redis-cli KEYS "vs:*" | xargs redis-cli DEL` - delete all keys that match pattern