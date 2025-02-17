// server.js (v1.10.10)

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
  return str.replace(/[<>'"]/g, '').trim();
}

// Local DB path in same folder
const DB_PATH = path.join(__dirname, 'applications.db');
const TEMPLATES_PATH = path.join(__dirname, 'emailTemplates.json');

// Basic Express setup
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Session config: simpler approach
app.use(session({
  secret: process.env.SESSION_SECRET || 'your_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,   // allow cookies even if Node sees HTTP
    httpOnly: true,
    sameSite: 'none' // cross-site usage
  }
}));

// Serve static from public
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware
function adminAuth(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.status(403).json({ error: 'Access denied' });
}

// Uploads only if admin
app.use('/uploads', adminAuth, express.static(path.join(__dirname, 'uploads')));

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuid.v4() + ext);
  }
});
const upload = multer({ storage });

// SQLite DB
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error('DB connection error:', err);
});

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

// If TEMPLATES_PATH exists, load from file
if (fs.existsSync(TEMPLATES_PATH)) {
  try {
    const data = fs.readFileSync(TEMPLATES_PATH, 'utf8');
    const fromFile = JSON.parse(data);
    if (fromFile.thankYou) emailTemplates.thankYou = fromFile.thankYou;
    if (fromFile.accepted) emailTemplates.accepted = fromFile.accepted;
    if (fromFile.rejected) emailTemplates.rejected = fromFile.rejected;
  } catch (err) {
    console.error('Error reading emailTemplates.json:', err);
  }
}

// Logging emails
function logEmail(toEmail, subject, message, success, errorMsg) {
  const eid = uuid.v4();
  db.run(`INSERT INTO email_logs (id, to_email, subject, message, success, error_message)
          VALUES (?, ?, ?, ?, ?, ?)`,
    [eid, toEmail, subject, message, success ? 1 : 0, errorMsg || null]);
}

// Send email via mail command
function sendMail(to, subject, message) {
  const cmd = `echo "${message}" | mail -s "${subject}" -a "From: mail@flat.surwave.ch" ${to}`;
  exec(cmd, (error) => {
    if (error) {
      logEmail(to, subject, message, false, error.message);
    } else {
      logEmail(to, subject, message, true, null);
    }
  });
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/', upload.array('documents', 10), (req, res) => {
  const firstname = sanitizeInput(req.body.firstname);
  const lastname = sanitizeInput(req.body.lastname);
  const email = sanitizeInput(req.body.email);
  const id = uuid.v4();

  const docs = req.files.map(f => ({
    path: `uploads/${f.filename}`,
    original: f.originalname
  }));
  const docsJSON = JSON.stringify(docs);

  db.run(`INSERT INTO applications (id, firstname, lastname, email, documents)
          VALUES (?, ?, ?, ?, ?)`,
    [id, firstname, lastname, email, docsJSON],
    function(err) {
      if (err) {
        console.error('DB insert error:', err);
        return res.status(500).json({ success: false, message: `Database error: ${err.message}` });
      }
      // Applicant email
      const text = emailTemplates.thankYou
        .replace('{{firstname}}', firstname)
        .replace('{{id}}', id);
      sendMail(email, 'Application Received', text);

      // Admin notify
      const adminText = `New application from ${firstname} ${lastname} (ID: ${id}).
Email: ${email}.
Documents: ${docs.map(d => d.original).join(', ')}`;
      sendMail('wohnung@surwave.ch', `New application (ID: ${id})`, adminText);

      res.json({
        success: true,
        message: `Your application was submitted successfully! A confirmation email has been sent with your reference ID: ${id}`
      });
    }
  );
});

// Admin login
app.post('/admin/login', (req, res) => {
  const username = sanitizeInput(req.body.username);
  const password = req.body.password || '';
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  db.get("SELECT * FROM admins WHERE username = ?", [username], (err, row) => {
    if (err) {
      db.run(`INSERT INTO login_logs (id, username, success, ip) VALUES (?, ?, ?, ?)`,
        [uuid.v4(), username, 0, ip]);
      return res.redirect('/admin/login.html?error=DbError');
    }
    if (!row) {
      db.run(`INSERT INTO login_logs (id, username, success, ip) VALUES (?, ?, ?, ?)`,
        [uuid.v4(), username, 0, ip]);
      return res.redirect('/admin/login.html?error=NoUser');
    }
    if (!bcrypt.compareSync(password, row.password)) {
      db.run(`INSERT INTO login_logs (id, username, success, ip) VALUES (?, ?, ?, ?)`,
        [uuid.v4(), username, 0, ip]);
      return res.redirect('/admin/login.html?error=BadPass');
    }

    // success
    db.run(`INSERT INTO login_logs (id, username, success, ip) VALUES (?, ?, ?, ?)`,
      [uuid.v4(), username, 1, ip]);

    req.session.admin = username;
    req.session.save(() => {
      res.redirect('/admin/dashboard.html');
    });
  });
});

// Admin logout
app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin/login.html');
  });
});

// Check if admin is logged in
app.get('/admin/api/status', (req, res) => {
  if (req.session && req.session.admin) {
    return res.json({ loggedIn: true });
  }
  res.json({ loggedIn: false });
});

// List applications
app.get('/admin/api/applications', adminAuth, (req, res) => {
  const { status, sortBy } = req.query;
  let baseQuery = 'SELECT * FROM applications';
  const conditions = [];
  const params = [];

  if (status && ['pending','accepted','rejected'].includes(status)) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (conditions.length) {
    baseQuery += ' WHERE ' + conditions.join(' AND ');
  }
  if (sortBy === 'created_atAsc') {
    baseQuery += ' ORDER BY created_at ASC';
  } else {
    baseQuery += ' ORDER BY created_at DESC';
  }

  db.all(baseQuery, params, (err, rows) => {
    if (err) return res.status(500).json({ error: `Database error: ${err.message}` });
    res.json(rows);
  });
});

// Update status
app.post('/admin/api/application/:id/status', adminAuth, (req, res) => {
  const id = req.params.id;
  const { status } = req.body;
  if (!['accepted','rejected'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  db.get('SELECT * FROM applications WHERE id=?', [id], (err, row) => {
    if (err) return res.status(500).json({ error: `Database error: ${err.message}` });
    if (!row) return res.status(404).json({ error: 'Application not found' });

    db.run('UPDATE applications SET status=? WHERE id=?', [status, id], function(err2) {
      if (err2) return res.status(500).json({ error: `Database error: ${err2.message}` });

      const template = (status==='accepted') ? emailTemplates.accepted : emailTemplates.rejected;
      const text = template
        .replace('{{firstname}}', row.firstname)
        .replace('{{id}}', id);
      sendMail(row.email, `Application ${status}`, text);

      res.json({ message: 'Status updated and email sent' });
    });
  });
});

// Delete application
app.delete('/admin/api/application/:id', adminAuth, (req, res) => {
  const id = req.params.id;
  db.run('DELETE FROM applications WHERE id=?', [id], function(err) {
    if (err) return res.status(500).json({ error: `Database error: ${err.message}` });
    if (this.changes===0) return res.status(404).json({ error: 'Application not found' });
    res.json({ message: 'Application deleted successfully' });
  });
});

// Count
app.get('/admin/api/count', adminAuth, (req, res) => {
  db.get('SELECT COUNT(*) as count FROM applications', (err, row) => {
    if (err) return res.status(500).json({ error: `Database error: ${err.message}` });
    res.json(row);
  });
});

// Email templates
app.get('/admin/api/templates', adminAuth, (req, res) => {
  res.json(emailTemplates);
});
app.post('/admin/api/templates', adminAuth, (req, res) => {
  emailTemplates = req.body;
  try {
    fs.writeFileSync(TEMPLATES_PATH, JSON.stringify(emailTemplates, null, 2));
    res.json({ message: 'Templates updated' });
  } catch(e) {
    res.status(500).json({ error: 'Could not write email templates file.' });
  }
});

// Change admin password
app.post('/admin/api/change-password', adminAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: 'Missing oldPassword or newPassword' });
  }
  const user = req.session.admin;
  db.get('SELECT * FROM admins WHERE username=?', [user], (err, row) => {
    if (err) return res.status(500).json({ error: `Database error: ${err.message}` });
    if (!row) return res.status(404).json({ error: 'Admin user not found' });
    if (!bcrypt.compareSync(oldPassword, row.password)) {
      return res.status(400).json({ error: 'Old password is incorrect' });
    }
    const hashed = bcrypt.hashSync(newPassword, 10);
    db.run('UPDATE admins SET password=? WHERE username=?', [hashed, user], function(err2) {
      if (err2) return res.status(500).json({ error: `Database error: ${err2.message}` });
      res.json({ message: 'Password changed successfully' });
    });
  });
});

// Failed login logs
app.get('/admin/api/failed-logins', adminAuth, (req, res) => {
  const page = parseInt(req.query.page||'1',10);
  const limit=10;
  const offset=(page-1)*limit;
  db.all('SELECT * FROM login_logs WHERE success=0 ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [limit, offset], (err, rows) => {
      if (err) return res.status(500).json({ error: `Database error: ${err.message}` });
      db.get('SELECT COUNT(*) as total FROM login_logs WHERE success=0', (e2, r2) => {
        if(e2) return res.status(500).json({ error: `Database error: ${e2.message}` });
        res.json({
          failedLogins: rows,
          total: r2.total,
          page,
          pages: Math.ceil(r2.total/limit)
        });
      });
    });
});

// Flush
app.delete('/admin/api/failed-logins', adminAuth, (req, res) => {
  db.run('DELETE FROM login_logs WHERE success=0', function(err){
    if(err) return res.status(500).json({ error: `Database error: ${err.message}` });
    res.json({ message: 'All failed login attempts have been deleted.' });
  });
});

// Start
app.listen(PORT, () => {
  console.log(`Server v1.10.10 running on port ${PORT}`);
});
