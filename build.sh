#!/usr/bin/env bash

cd "$(dirname "$0")"
ver=$(cat ./VERSION)
cr="gcr.io/apt-phenomenon-243802"

docker build . -t "${cr}/vecsearch:${ver}" -f ./Dockerfile
docker push "${cr}/vecsearch:${ver}"

cd -