#!/bin/bash
# deploy.sh: Script to set up the database and necessary directories

# Create uploads directory if it doesn't exist
mkdir -p uploads

# Initialize SQLite database and create necessary tables
sqlite3 applications.db <<EOF
CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    firstname TEXT,
    lastname TEXT,
    email TEXT,
    documents TEXT,
    ip TEXT,                         -- New column for logging submitter's IP
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS email_logs (
    id TEXT PRIMARY KEY,
    to_email TEXT,
    subject TEXT,
    message TEXT,
    success INTEGER,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS admins (
    username TEXT PRIMARY KEY,
    password TEXT
);
EOF

echo "Deployment complete. Database and uploads directory are set up."
