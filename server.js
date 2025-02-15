// server.js (v1.2.0)

const express = require('express');
const session = require('express-session');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const uuid = require('uuid');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');

// Minimal XSS Sanitization
function sanitizeInput(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>'"]/g, '').trim();
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'your_secret_key',
  resave: false,
  saveUninitialized: false,
}));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
// Serve uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Configure Multer to keep the original extension
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

// Setup SQLite
const db = new sqlite3.Database('./applications.db', (err) => {
  if (err) console.error('DB connection error:', err);
  else console.log('Connected to SQLite database.');
});

// Create or update necessary tables
db.serialize(() => {
  // Table: applications
  db.run(`CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    firstname TEXT,
    lastname TEXT,
    email TEXT,
    documents TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Table: admins
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
});

// emailTemplates.json
const templatesFile = path.join(__dirname, 'emailTemplates.json');
let emailTemplates = {
  thankYou: "Dear {{firstname}},\n\nThank you for your application. Your reference ID is {{id}}.",
  accepted: "Dear {{firstname}},\n\nCongratulations! Your application (ID: {{id}}) has been accepted and will be forwarded to the agency.",
  rejected: "Dear {{firstname}},\n\nWe regret to inform you that your application (ID: {{id}}) has been rejected."
};
if (fs.existsSync(templatesFile)) {
  emailTemplates = JSON.parse(fs.readFileSync(templatesFile));
}

// mailConfig.json
const mailConfigFile = path.join(__dirname, 'mailConfig.json');
let mailConfig = {
  host: "smtp.example.com",
  port: 587,
  secure: false,
  user: "username@example.com",
  pass: "password"
};
if (fs.existsSync(mailConfigFile)) {
  mailConfig = JSON.parse(fs.readFileSync(mailConfigFile));
}

// Use nodemailer with the config from mailConfig
async function sendMail(to, subject, message) {
  try {
    let transporter = nodemailer.createTransport({
      host: mailConfig.host,
      port: mailConfig.port,
      secure: mailConfig.secure,
      auth: {
        user: mailConfig.user,
        pass: mailConfig.pass
      }
    });
    await transporter.sendMail({
      from: mailConfig.user,
      to,
      subject,
      text: message
    });
    console.log(`Email sent to ${to}`);
  } catch (err) {
    console.error(`Error sending email: ${err.message}`);
  }
}

// ----- ROUTES -----

// GET / => index
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// POST / => handle new application
app.post('/', upload.array('documents', 10), async (req, res) => {
  try {
    const firstname = sanitizeInput(req.body.firstname);
    const lastname = sanitizeInput(req.body.lastname);
    const email = sanitizeInput(req.body.email);

    const id = uuid.v4();
    const docPaths = req.files.map(file => `uploads/${file.filename}`);
    const documentsJSON = JSON.stringify(docPaths);

    db.run(`
      INSERT INTO applications (id, firstname, lastname, email, documents)
      VALUES (?, ?, ?, ?, ?)`,
      [id, firstname, lastname, email, documentsJSON],
      async function(err) {
        if (err) {
          console.error("DB insert error:", err);
          return res.status(500).json({ success: false, error: `Database error: ${err.message}` });
        }
        // send email
        const emailText = emailTemplates.thankYou
          .replace('{{firstname}}', firstname)
          .replace('{{id}}', id);
        await sendMail(email, 'Application Received', emailText);

        // return valid JSON
        return res.json({
          success: true,
          message: "Application submitted successfully. Your reference ID is: " + id
        });
      }
    );
  } catch (ex) {
    console.error("POST / error:", ex);
    return res.status(500).json({ success: false, error: ex.message });
  }
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

function adminAuth(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.redirect('/admin/login.html');
}

// Admin status
app.get('/admin/api/status', (req, res) => {
  if (req.session && req.session.admin) {
    return res.json({ loggedIn: true });
  }
  res.json({ loggedIn: false });
});

// Filter & sort
app.get('/admin/api/applications', adminAuth, (req, res) => {
  const { status, sortBy } = req.query;
  let baseQuery = "SELECT * FROM applications";
  const conditions = [];
  const params = [];

  // If user selected a status
  if (status && ['pending','accepted','rejected'].includes(status)) {
    conditions.push("status = ?");
    params.push(status);
  }
  if (conditions.length > 0) {
    baseQuery += " WHERE " + conditions.join(" AND ");
  }
  // sort
  if (sortBy === 'created_atAsc') {
    baseQuery += " ORDER BY created_at ASC";
  } else {
    // default or 'created_atDesc'
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
app.post('/admin/api/application/:id/status', adminAuth, async (req, res) => {
  const id = req.params.id;
  const { status } = req.body;
  if (!['accepted','rejected'].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  db.get("SELECT * FROM applications WHERE id = ?", [id], async (err, row) => {
    if (err) {
      console.error("DB fetch error (status update):", err);
      return res.status(500).json({ error: `Database error: ${err.message}` });
    }
    if (!row) {
      return res.status(404).json({ error: "Application not found" });
    }
    db.run("UPDATE applications SET status = ? WHERE id = ?", [status, id], async function(err2) {
      if (err2) {
        console.error("DB update error (status):", err2);
        return res.status(500).json({ error: `Database error: ${err2.message}` });
      }
      let template = status === 'accepted' ? emailTemplates.accepted : emailTemplates.rejected;
      let emailText = template.replace('{{firstname}}', row.firstname).replace('{{id}}', id);
      await sendMail(row.email, 'Application ' + status.charAt(0).toUpperCase() + status.slice(1), emailText);
      res.json({ message: "Status updated and email sent" });
    });
  });
});

// Delete
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

// Email templates
app.get('/admin/api/templates', adminAuth, (req, res) => {
  res.json(emailTemplates);
});
app.post('/admin/api/templates', adminAuth, (req, res) => {
  emailTemplates = req.body;
  fs.writeFileSync(templatesFile, JSON.stringify(emailTemplates, null, 2));
  res.json({ message: "Templates updated" });
});

// Mail config (from mailConfig.json)
app.get('/admin/api/mail-config', adminAuth, (req, res) => {
  res.json(mailConfig);
});
app.post('/admin/api/mail-config', adminAuth, (req, res) => {
  const { host, port, secure, user, pass } = req.body;
  mailConfig.host = host || 'smtp.example.com';
  mailConfig.port = parseInt(port, 10) || 587;
  mailConfig.secure = !!secure;
  mailConfig.user = user || '';
  mailConfig.pass = pass || '';
  fs.writeFileSync(mailConfigFile, JSON.stringify(mailConfig, null, 2));
  return res.json({ message: 'Mail config updated' });
});

app.listen(PORT, () => {
  console.log(`Server v1.2.0 running on port ${PORT}`);
});
