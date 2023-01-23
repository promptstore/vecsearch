#!/usr/bin/env bash

helm3 upgrade vecsearch -n nudge --set db.user="${DBUSER}" --set db.pass="${DBPASS}" ./helm-chart