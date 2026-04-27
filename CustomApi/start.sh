#!/bin/sh

# Wait for database migration
sleep 2

# Start kilo server
kilo serve --port 8787 --hostname 0.0.0.0
