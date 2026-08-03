#!/bin/bash
# walt-insecure.sh - Run walt CLI with SSL certificate verification disabled
# 
# Use this when connecting to remote systems with self-signed certificates.
# For production use, install the proper CA certificate instead.

export NODE_TLS_REJECT_UNAUTHORIZED=0

npx tsx walt.ts "$@"
