// server.js (v1.10.6)

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

// Use absolute paths to avoid confusion with working directories
const DB_PATH = path.join(__dirname, 'applications.db');
const TEMPLATES_PATH = path.join(__dirname, 'emailTemplates.json');

console.log(`Using database at: ${DB_PATH}`);
console.log(`Using templates file at: ${TEMPLATES_PATH}`);

const app = express();

// If behind Plesk or another proxy, trust it so secure cookies & sessions work
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;

// Parse URL-encoded and JSON bodies
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/*
  Session config for HTTPS behind a proxy:
  - cookie.domain: ".surwave.ch" so subdomains (flat.surwave.ch) share cookies
  - secure: true => only send over HTTPS
  - sameSite: 'none' => cross-site usage allowed
  - resave: true & rolling: true => refresh session cookie on each response
  - saveUninitialized: false => do not create empty sessions
*/
app.use(session({
  secret: process.env.SESSION_SECRET || 'your_secret_key',
  resave: true,
  rolling: true,
  saveUninitialized: false,
  cookie: {
    domain: '.surwave.ch',   // Key for subdomain usage
    secure: true,            // HTTPS only
    httpOnly: true,
    sameSite: 'none',        // needed for cross-site usage
    maxAge: 24 * 60 * 60 * 1000 // e.g. 24 hours
  }
}));

// Serve static files from public/
app.use(express.static(path.join(__dirname, 'public')));

// adminAuth: return JSON if unauthorized; log session for debugging
function adminAuth(req, res, next) {
  console.log('adminAuth => session:', req.session);
  if (req.session && req.session.admin) {
    return next();
  }
  return res.status(403).json({ error: 'Access denied' });
}

// Serve uploads only for authenticated admin users
app.use('/uploads', adminAuth, express.static(path.join(__dirname, 'uploads')));

// Configure Multer: store original filename
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = uuid.v4() + ext;
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

// Database setup
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error("DB connection error:", err);
  else console.log('Connected to SQLite database.');
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

  db.run(`CREATE TABLE IF NOT EXISTS email_logs (
    id TEXT PRIMARY KEY,
    to_email TEXT,
    subject TEXT,
    message TEXT,
    success INTEGER,
    error_message TEXT,
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
        console.log("Inserted default admin user with hashed password.");
      }
    });
  });

  db.run(`CREATE TABLE IF NOT EXISTS login_logs (
    id TEXT PRIMARY KEY,
    username TEXT,
    success INTEGER,
    ip TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Default email templates
let emailTemplates = {
  thankYou: `Dear {{firstname}},

Thank you for submitting your application. Your reference ID is {{id}}.
We will contact you as soon as possible regarding the next steps.

Best Regards
`,
  accepted: `Dear {{firstname}},

Congratulations! Your application (ID: {{id}}) has been accepted and will be forwarded to the agency.
We will contact you to obtain further information about your application.

Many thanks.
Best Regards
`,
  rejected: `Dear {{firstname}},

We regret to inform you that your application (ID: {{id}}) has been rejected.
We would like to thank you for your efforts and your interest in the apartment and wish you all the best.

Best Regards
`
};

if (fs.existsSync(TEMPLATES_PATH)) {
  try {
    const data = fs.readFileSync(TEMPLATES_PATH, 'utf8');
    const fromFile = JSON.parse(data);
    if (fromFile.thankYou) emailTemplates.thankYou = fromFile.thankYou;
    if (fromFile.accepted) emailTemplates.accepted = fromFile.accepted;
    if (fromFile.rejected) emailTemplates.rejected = fromFile.rejected;
    console.log("Loaded templates from file:", emailTemplates);
  } catch (err) {
    console.error("Error reading emailTemplates.json:", err);
  }
} else {
  console.log("No emailTemplates.json found; using defaults in memory.");
}

function logEmail(toEmail, subject, message, success, errorMsg) {
  const eid = uuid.v4();
  db.run(`
    INSERT INTO email_logs (id, to_email, subject, message, success, error_message)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [eid, toEmail, subject, message, success ? 1 : 0, errorMsg || null]);
}

// Use system mail command with a fixed sender address
function sendMail(to, subject, message) {
  const mailCommand = `echo "${message}" | mail -s "${subject}" -a "From: mail@flat.surwave.ch" ${to}`;
  exec(mailCommand, (error, stdout, stderr) => {
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
  const firstname = sanitizeInput(req.body.firstname);
  const lastname = sanitizeInput(req.body.lastname);
  const email = sanitizeInput(req.body.email);

  const id = uuid.v4();
  const docs = req.files.map(file => ({
    path: `uploads/${file.filename}`,
    original: file.originalname
  }));
  const documentsJSON = JSON.stringify(docs);

  db.run(`
    INSERT INTO applications (id, firstname, lastname, email, documents)
    VALUES (?, ?, ?, ?, ?)
  `, [id, firstname, lastname, email, documentsJSON], function(err) {
    if (err) {
      console.error("DB insert error:", err);
      return res.status(500).json({ success: false, message: `Database error: ${err.message}` });
    }
    // Send email to the applicant
    const emailText = emailTemplates.thankYou
      .replace('{{firstname}}', firstname)
      .replace('{{id}}', id);
    sendMail(email, 'Application Received', emailText);

    // Also send an email to "wohnung@surwave.ch"
    const adminNotify = `New application from ${firstname} ${lastname} (ID: ${id}). 
Email: ${email}.
Uploaded documents: ${docs.map(d => d.original).join(', ')}.`;
    sendMail('wohnung@surwave.ch', `New application (ID: ${id})`, adminNotify);

    return res.json({
      success: true,
      message: `Your application was submitted successfully! A confirmation email has been sent with your reference ID: ${id}`
    });
  });
});

// Admin login
app.post('/admin/login', (req, res) => {
  const username = sanitizeInput(req.body.username);
  const password = req.body.password || '';

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  db.get("SELECT * FROM admins WHERE username = ?", [username], (err, row) => {
    if (err) {
      console.error("Admin login db error:", err);
      db.run("INSERT INTO login_logs (id, username, success, ip) VALUES (?, ?, ?, ?)",
        [uuid.v4(), username, 0, ip]);
      return res.redirect('/admin/login.html?error=DbError');
    }
    if (!row) {
      db.run("INSERT INTO login_logs (id, username, success, ip) VALUES (?, ?, ?, ?)",
        [uuid.v4(), username, 0, ip]);
      return res.redirect('/admin/login.html?error=NoUser');
    }
    const match = bcrypt.compareSync(password, row.password);
    if (!match) {
      db.run("INSERT INTO login_logs (id, username, success, ip) VALUES (?, ?, ?, ?)",
        [uuid.v4(), username, 0, ip]);
      return res.redirect('/admin/login.html?error=BadPass');
    }

    // Log success
    db.run("INSERT INTO login_logs (id, username, success, ip) VALUES (?, ?, ?, ?)",
      [uuid.v4(), username, 1, ip]);

    // *** Set the session admin
    req.session.admin = username;
    req.session.save(err2 => {
      if (err2) console.error('Session save error:', err2);
      console.log('Admin login success, session=', req.session);
      res.redirect('/admin/dashboard.html');
    });
  });
});

// Admin logout
app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login.html');
});

// Check if admin is logged in
app.get('/admin/api/status', (req, res) => {
  console.log('/admin/api/status => session:', req.session);
  if (req.session && req.session.admin) {
    return res.json({ loggedIn: true });
  }
  return res.json({ loggedIn: false });
});

// Filter & Sort Applications
app.get('/admin/api/applications', adminAuth, (req, res) => {
  const { status, sortBy } = req.query;
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
  if (sortBy === 'created_atAsc') {
    baseQuery += " ORDER BY created_at ASC";
  } else if (sortBy === 'created_atDesc') {
    baseQuery += " ORDER BY created_at DESC";
  } else {
    baseQuery += " ORDER BY created_at DESC";
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
      let template = (status === 'accepted') ? emailTemplates.accepted : emailTemplates.rejected;
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

// Email templates
app.get('/admin/api/templates', adminAuth, (req, res) => {
  console.log("Returning templates to admin:", emailTemplates);
  res.json(emailTemplates);
});
app.post('/admin/api/templates', adminAuth, (req, res) => {
  emailTemplates = req.body;
  try {
    fs.writeFileSync(TEMPLATES_PATH, JSON.stringify(emailTemplates, null, 2));
    console.log("Templates updated to:", emailTemplates);
    res.json({ message: "Templates updated" });
  } catch (err) {
    console.error("Error writing templates file:", err);
    return res.status(500).json({ error: "Could not write email templates file." });
  }
});

// Change admin password
app.post('/admin/api/change-password', adminAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: "Missing oldPassword or newPassword" });
  }
  const adminUser = req.session.admin;
  db.get("SELECT * FROM admins WHERE username = ?", [adminUser], (err, row) => {
    if (err) {
      console.error("Error fetching admin for password change:", err);
      return res.status(500).json({ error: `Database error: ${err.message}` });
    }
    if (!row) {
      return res.status(404).json({ error: "Admin user not found" });
    }
    const match = bcrypt.compareSync(oldPassword, row.password);
    if (!match) {
      return res.status(400).json({ error: "Old password is incorrect" });
    }
    const hashedNew = bcrypt.hashSync(newPassword, 10);
    db.run("UPDATE admins SET password = ? WHERE username = ?", [hashedNew, adminUser], function(err2) {
      if (err2) {
        console.error("Error updating admin password:", err2);
        return res.status(500).json({ error: `Database error: ${err2.message}` });
      }
      res.json({ message: "Password changed successfully" });
    });
  });
});

// Failed logins with pagination
app.get('/admin/api/failed-logins', adminAuth, (req, res) => {
  const page = parseInt(req.query.page || '1', 10);
  const limit = 10;
  const offset = (page - 1) * limit;

  db.all(
    "SELECT * FROM login_logs WHERE success=0 ORDER BY created_at DESC LIMIT ? OFFSET ?",
    [limit, offset],
    (err, rows) => {
      if (err) {
        console.error("DB fetch error (failed logins):", err);
        return res.status(500).json({ error: `Database error: ${err.message}` });
      }
      db.get("SELECT COUNT(*) as total FROM login_logs WHERE success=0", (err2, row) => {
        if (err2) {
          console.error("DB count error (failed logins):", err2);
          return res.status(500).json({ error: `Database error: ${err2.message}` });
        }
        res.json({
          failedLogins: rows,
          total: row.total,
          page,
          pages: Math.ceil(row.total / limit)
        });
      });
    }
  );
});

// Flush all failed logins
app.delete('/admin/api/failed-logins', adminAuth, (req, res) => {
  db.run("DELETE FROM login_logs WHERE success=0", function(err) {
    if (err) {
      console.error("Error flushing failed logins:", err);
      return res.status(500).json({ error: `Database error: ${err.message}` });
    }
    res.json({ message: "All failed login attempts have been deleted." });
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server v1.10.6 running on port ${PORT}`);
});
