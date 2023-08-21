#!/usr/bin/env bash

helm3 upgrade vecsearch -n vecsearch --set db.user="${DBUSER}" --set db.pass="${DBPASS}" ./helm-chart