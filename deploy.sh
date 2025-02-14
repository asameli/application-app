#!/bin/bash
# deploy.sh: Script to set up the database and necessary directories

# Create uploads directory if it doesn't exist
mkdir -p uploads

# Initialize SQLite database and create the applications table
sqlite3 applications.db <<EOF
CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    firstname TEXT,
    lastname TEXT,
    email TEXT,
    documents TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
EOF