#!/usr/bin/env bash

cd "$(dirname "$0")"
ver=$(cat ./VERSION)
app=$APP_IMAGE_NAME
cr=$CONTAINER_REGISTRY

docker build . -t "${cr}/${app}:${ver}"
docker push "${cr}/${app}:${ver}"

cd -