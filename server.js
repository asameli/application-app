// server.js (v1.2.0)

const express = require('express');
const session = require('express-session');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const uuid = require('uuid');
const { exec } = require('child_process');
const bcrypt = require('bcryptjs');

// Minimal XSS Sanitization
function sanitizeInput(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/[<>'"]/g, '') // remove special chars
    .trim();
}

const app = express();
const PORT = process.env.PORT || 3000;

// Parse URL-encoded and JSON bodies
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Session for admin auth
app.use(session({
  secret: process.env.SESSION_SECRET || 'your_secret_key',
  resave: false,
  saveUninitialized: false,
}));

// Serve static files from public/
app.use(express.static(path.join(__dirname, 'public')));
// Serve uploads so docs can be downloaded
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Configure Multer: store original filename
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    // uuid + original extension
    const ext = path.extname(file.originalname);
    const uniqueName = uuid.v4() + ext;
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

// Database setup
const db = new sqlite3.Database('./applications.db', (err) => {
  if (err) console.error("DB connection error:", err);
  else console.log('Connected to SQLite database.');
});

// Create tables if not exist
db.serialize(() => {
  // applications table
  db.run(`CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    firstname TEXT,
    lastname TEXT,
    email TEXT,
    documents TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // email_logs table
  db.run(`CREATE TABLE IF NOT EXISTS email_logs (
    id TEXT PRIMARY KEY,
    to_email TEXT,
    subject TEXT,
    message TEXT,
    success INTEGER,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // admins table
  db.run(`CREATE TABLE IF NOT EXISTS admins (
    username TEXT PRIMARY KEY,
    password TEXT
  )`, () => {
    // Insert default admin if not exist
    db.get("SELECT * FROM admins WHERE username = ?", ['admin'], (err2, row) => {
      if (!row) {
        // Hash default pass 'adminpass'
        const hashed = bcrypt.hashSync('adminpass', 10);
        db.run("INSERT INTO admins (username, password) VALUES (?, ?)", ['admin', hashed]);
        console.log("Inserted default admin user with hashed password.");
      }
    });
  });
});

// Load email templates
const templatesFile = path.join(__dirname, 'emailTemplates.json');
let emailTemplates = {
  thankYou: "Dear {{firstname}},\n\nThank you for your application. Your reference ID is {{id}}.",
  accepted: "Dear {{firstname}},\n\nCongratulations! Your application (ID: {{id}}) has been accepted and will be forwarded to the agency.",
  rejected: "Dear {{firstname}},\n\nWe regret to inform you that your application (ID: {{id}}) has been rejected."
};
if (fs.existsSync(templatesFile)) {
  emailTemplates = JSON.parse(fs.readFileSync(templatesFile));
}

function logEmail(toEmail, subject, message, success, errorMsg) {
  const eid = uuid.v4();
  db.run(`INSERT INTO email_logs (id, to_email, subject, message, success, error_message)
    VALUES (?, ?, ?, ?, ?, ?)`,
    [eid, toEmail, subject, message, success ? 1 : 0, errorMsg || null]);
}

// Use system mail command
function sendMail(to, subject, message) {
  const mailCommand = `echo "${message}" | mail -s "${subject}" ${to}`;
  exec(mailCommand, (error) => {
    if (error) {
      console.error(`Error sending email: ${error.message}`);
      logEmail(to, subject, message, false, error.message);
    } else {
      console.log(`Email sent to ${to}`);
      logEmail(to, subject, message, true, null);
    }
  });
}

//--- ROUTES ---

// Root => index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Post => form submission
app.post('/', upload.array('documents', 10), (req, res) => {
  // minimal XSS sanitization
  const firstname = sanitizeInput(req.body.firstname);
  const lastname = sanitizeInput(req.body.lastname);
  const email = sanitizeInput(req.body.email);

  const id = uuid.v4();
  // Store document paths along with original filenames
  const docs = req.files.map(file => ({ path: `uploads/${file.filename}`, original: file.originalname }));
  const documentsJSON = JSON.stringify(docs);

  db.run(
    `INSERT INTO applications (id, firstname, lastname, email, documents)
     VALUES (?, ?, ?, ?, ?)`,
    [id, firstname, lastname, email, documentsJSON],
    function(err) {
      if (err) {
        console.error("DB insert error:", err);
        return res.status(500).send(`Database error: ${err.message}`);
      }
      // send email
      const emailText = emailTemplates.thankYou
        .replace('{{firstname}}', firstname)
        .replace('{{id}}', id);
      sendMail(email, 'Application Received', emailText);

      // Return JSON with a modern overlay-friendly success message
      res.json({ 
        success: true, 
        message: "Your application was submitted successfully! A confirmation email has been sent with your reference ID: " + id 
      });
    }
  );
});

// Admin login
app.post('/admin/login', (req, res) => {
  const username = sanitizeInput(req.body.username);
  const password = req.body.password || '';

  db.get("SELECT * FROM admins WHERE username = ?", [username], (err, row) => {
    if (err) {
      console.error("Admin login db error:", err);
      return res.redirect('/admin/login.html?error=DbError');
    }
    if (!row) {
      return res.redirect('/admin/login.html?error=NoUser');
    }
    // Compare password
    const match = bcrypt.compareSync(password, row.password);
    if (!match) {
      return res.redirect('/admin/login.html?error=BadPass');
    }
    req.session.admin = username;
    res.redirect('/admin/dashboard.html');
  });
});

// Admin logout
app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login.html');
});

// Middleware for admin routes
function adminAuth(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.redirect('/admin/login.html');
}

// Check if admin is logged in
app.get('/admin/api/status', (req, res) => {
  if (req.session && req.session.admin) return res.json({ loggedIn: true });
  res.json({ loggedIn: false });
});

// Filter & Sort Applications
app.get('/admin/api/applications', adminAuth, (req, res) => {
  const { status, sortBy } = req.query; // status=accepted/pending/rejected, sortBy=created_atAsc, etc.

  let baseQuery = "SELECT * FROM applications";
  const conditions = [];
  const params = [];

  if (status && ['pending','accepted','rejected'].includes(status)) {
    conditions.push("status = ?");
    params.push(status);
  }
  if (conditions.length > 0) {
    baseQuery += " WHERE " + conditions.join(" AND ");
  }

  // Sorting
  if (sortBy === 'created_atAsc') {
    baseQuery += " ORDER BY created_at ASC";
  } else if (sortBy === 'created_atDesc') {
    baseQuery += " ORDER BY created_at DESC";
  } else {
    baseQuery += " ORDER BY created_at DESC"; // default
  }

  db.all(baseQuery, params, (err, rows) => {
    if (err) {
      console.error("DB fetch error (list apps):", err);
      return res.status(500).json({ error: `Database error: ${err.message}` });
    }
    res.json(rows);
  });
});

// Update status
app.post('/admin/api/application/:id/status', adminAuth, (req, res) => {
  const id = req.params.id;
  const { status } = req.body;
  if (!['accepted', 'rejected'].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  db.get("SELECT * FROM applications WHERE id = ?", [id], (err, row) => {
    if (err) {
      console.error("DB fetch error (status update):", err);
      return res.status(500).json({ error: `Database error: ${err.message}` });
    }
    if (!row) {
      console.error("No application found for ID:", id);
      return res.status(404).json({ error: "Application not found" });
    }
    db.run("UPDATE applications SET status = ? WHERE id = ?", [status, id], function(err2) {
      if (err2) {
        console.error("DB update error (status):", err2);
        return res.status(500).json({ error: `Database error: ${err2.message}` });
      }
      let template = status === 'accepted' ? emailTemplates.accepted : emailTemplates.rejected;
      let emailText = template
        .replace('{{firstname}}', row.firstname)
        .replace('{{id}}', id);
      sendMail(row.email, 'Application ' + status.charAt(0).toUpperCase() + status.slice(1), emailText);
      res.json({ message: "Status updated and email sent" });
    });
  });
});

// Delete application
app.delete('/admin/api/application/:id', adminAuth, (req, res) => {
  const id = req.params.id;
  db.run("DELETE FROM applications WHERE id = ?", [id], function(err) {
    if (err) {
      console.error("DB delete error:", err);
      return res.status(500).json({ error: `Database error: ${err.message}` });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: "Application not found" });
    }
    res.json({ message: "Application deleted successfully" });
  });
});

// Count applications
app.get('/admin/api/count', adminAuth, (req, res) => {
  db.get("SELECT COUNT(*) as count FROM applications", (err, row) => {
    if (err) {
      console.error("DB count error:", err);
      return res.status(500).json({ error: `Database error: ${err.message}` });
    }
    res.json(row);
  });
});

// Email logs endpoint
app.get('/admin/api/email-logs', adminAuth, (req, res) => {
  db.all("SELECT * FROM email_logs ORDER BY created_at DESC", [], (err, rows) => {
    if (err) {
      console.error("DB email_logs fetch error:", err);
      return res.status(500).json({ error: `Database error: ${err.message}` });
    }
    res.json(rows);
  });
});

// Get/Update email templates
app.get('/admin/api/templates', adminAuth, (req, res) => {
  res.json(emailTemplates);
});
app.post('/admin/api/templates', adminAuth, (req, res) => {
  emailTemplates = req.body;
  fs.writeFileSync(templatesFile, JSON.stringify(emailTemplates, null, 2));
  res.json({ message: "Templates updated" });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server v1.2.0 running on port ${PORT}`);
});
