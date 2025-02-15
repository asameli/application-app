// server.js (Restored & Fixed Version)

const express = require('express');
const session = require('express-session');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const uuid = require('uuid');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: 'your_secret_key',
  resave: false,
  saveUninitialized: false,
}));

// Serve static files
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Database Connection
const db = new sqlite3.Database('./applications.db', (err) => {
  if (err) console.error("DB connection error:", err);
  else console.log('Connected to SQLite database.');
});

// Create tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    firstname TEXT,
    lastname TEXT,
    email TEXT,
    documents TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS admins (
    username TEXT PRIMARY KEY,
    password TEXT
  )`, () => {
    db.get("SELECT * FROM admins WHERE username = ?", ['admin'], (err2, row) => {
      if (!row) {
        const hashed = bcrypt.hashSync('adminpass', 10);
        db.run("INSERT INTO admins (username, password) VALUES (?, ?)", ['admin', hashed]);
        console.log("Inserted default admin user.");
      }
    });
  });
});

// File Upload Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuid.v4() + ext.toLowerCase());
  }
});
const upload = multer({ storage });

// Serve Index Page
app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

// Submit Application
app.post('/', upload.array('documents', 10), (req, res) => {
  const { firstname, lastname, email } = req.body;
  const id = uuid.v4();
  const documents = JSON.stringify(req.files.map(file => `uploads/${file.filename}`));

  db.run(`INSERT INTO applications (id, firstname, lastname, email, documents)
          VALUES (?, ?, ?, ?, ?)`, [id, firstname, lastname, email, documents], function(err) {
    if (err) {
      console.error("DB insert error:", err);
      return res.status(500).json({ success: false, error: `Database error: ${err.message}` });
    }
    res.json({ success: true, message: "Application submitted successfully. Your reference ID is: " + id });
  });
});

// Admin Panel Routes
app.get('/admin', (req, res) => res.sendFile(__dirname + '/public/admin/dashboard.html'));

// Admin Login
app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  db.get("SELECT * FROM admins WHERE username = ?", [username], (err, row) => {
    if (err) return res.redirect('/admin/login.html?error=DbError');
    if (!row || !bcrypt.compareSync(password, row.password)) {
      return res.redirect('/admin/login.html?error=BadCreds');
    }
    req.session.admin = username;
    res.redirect('/admin/dashboard.html');
  });
});

// Logout
app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Fetch Applications for Admin Panel
app.get('/admin/api/applications', (req, res) => {
  const { status, sortBy } = req.query;
  let query = "SELECT * FROM applications";
  const params = [];

  if (status) {
    query += " WHERE status = ?";
    params.push(status);
  }
  if (sortBy === 'created_atAsc') query += " ORDER BY created_at ASC";
  else query += " ORDER BY created_at DESC";

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: `Database error: ${err.message}` });
    res.json(rows);
  });
});

// Update Application Status
app.post('/admin/api/application/:id/status', (req, res) => {
  const { status } = req.body;
  const id = req.params.id;

  db.run("UPDATE applications SET status = ? WHERE id = ?", [status, id], function(err) {
    if (err) return res.status(500).json({ error: `Database error: ${err.message}` });
    res.json({ message: "Status updated successfully." });
  });
});

// Delete Application
app.delete('/admin/api/application/:id', (req, res) => {
  const id = req.params.id;
  db.run("DELETE FROM applications WHERE id = ?", [id], function(err) {
    if (err) return res.status(500).json({ error: `Database error: ${err.message}` });
    res.json({ message: "Application deleted successfully." });
  });
});

// Start Server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
