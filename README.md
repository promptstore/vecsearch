# vecsearch

Deployment:

    eval $(./export-env.sh .env)
    ./deploy.sh


Local Test:

    docker run -p 6010:6010 --net="host" --rm --env-file dev.env --name vecsearch gcr.io/apt-phenomenon-243802/vecsearch:0.0.1


## Curl Examples

Create Schema

    curl -vL -H 'Content-Type: application/json' "http://localhost:5000/api/index" -d @fixtures/schema.json


Index Document

    curl -vL -H 'Content-Type: multipart/form-data' -F 'file=@amazon_products.csv' -F 'indexName=amazon_products' "http://localhost:5000/api/upload"


Search

    curl -vL "http://localhost:5000/api/search?q=ostrich&indexName=amazon_products" | jq