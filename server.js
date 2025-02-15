// server.js (Stable Version)

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
  secret: 'your_secret_key', // Replace with an env var in production
  resave: false,
  saveUninitialized: false,
}));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Database
const db = new sqlite3.Database('./applications.db', (err) => {
  if (err) {
    console.error('DB connection error:', err);
  } else {
    console.log('Connected to SQLite database.');
  }
});

// Create tables if not exist
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
        // Insert default admin with hashed password 'adminpass'
        const hashed = bcrypt.hashSync('adminpass', 10);
        db.run("INSERT INTO admins (username, password) VALUES (?, ?)", ['admin', hashed]);
        console.log("Inserted default admin user with hashed password.");
      }
    });
  });
});

// Configure multer to keep file’s original extension
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueName = uuid.v4() + ext;
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

// Serve main index
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// POST => application form
app.post('/', upload.array('documents', 10), (req, res) => {
  const { firstname, lastname, email } = req.body;
  const id = uuid.v4();
  // Store doc paths with original extension
  const docPaths = req.files.map(file => `uploads/${file.filename}`);
  const documentsJSON = JSON.stringify(docPaths);

  db.run(`
    INSERT INTO applications (id, firstname, lastname, email, documents)
    VALUES (?, ?, ?, ?, ?)`,
    [id, firstname, lastname, email, documentsJSON],
    function(err) {
      if (err) {
        console.error('DB insert error:', err);
        return res.status(500).json({ success: false, error: `Database error: ${err.message}` });
      }
      // Return valid JSON
      res.json({
        success: true,
        message: 'Application submitted successfully. Your reference ID is: ' + id
      });
    }
  );
});

// Admin login route
app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  db.get("SELECT * FROM admins WHERE username = ?", [username], (err, row) => {
    if (err) {
      console.error('Admin login error:', err);
      return res.redirect('/admin/login.html?error=DbError');
    }
    if (!row) {
      return res.redirect('/admin/login.html?error=NoUser');
    }
    const match = bcrypt.compareSync(password, row.password);
    if (!match) {
      return res.redirect('/admin/login.html?error=BadCreds');
    }
    req.session.admin = username;
    res.redirect('/admin/dashboard.html');
  });
});

// Admin logout
app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Protect admin routes
function adminAuth(req, res, next) {
  if (req.session && req.session.admin) {
    return next();
  }
  return res.redirect('/admin/login.html');
}

// GET applications with optional status, sort
app.get('/admin/api/applications', adminAuth, (req, res) => {
  let { status, sortBy } = req.query;
  let sql = "SELECT * FROM applications";
  const params = [];

  if (status && (status === 'pending' || status === 'accepted' || status === 'rejected')) {
    sql += " WHERE status = ?";
    params.push(status);
  }
  if (sortBy === 'created_atAsc') {
    sql += " ORDER BY created_at ASC";
  } else {
    // default or 'created_atDesc'
    sql += " ORDER BY created_at DESC";
  }

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Fetch apps error:', err);
      return res.status(500).json({ error: `Database error: ${err.message}` });
    }
    res.json(rows);
  });
});

// Update application status
app.post('/admin/api/application/:id/status', adminAuth, (req, res) => {
  const { status } = req.body;
  const id = req.params.id;

  if (!['pending','accepted','rejected'].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  db.run("UPDATE applications SET status = ? WHERE id = ?", [status, id], function(err) {
    if (err) {
      console.error("Update status error:", err);
      return res.status(500).json({ error: `Database error: ${err.message}` });
    }
    res.json({ message: "Status updated successfully." });
  });
});

// Delete application
app.delete('/admin/api/application/:id', adminAuth, (req, res) => {
  const id = req.params.id;
  db.run("DELETE FROM applications WHERE id = ?", [id], function(err) {
    if (err) {
      console.error("Delete app error:", err);
      return res.status(500).json({ error: `Database error: ${err.message}` });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: "Application not found" });
    }
    res.json({ message: "Application deleted successfully." });
  });
});

// No mail config references => ignoring any leftover mail_config table

// Start server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
