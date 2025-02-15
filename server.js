// server.js (v1.1.2)

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

// Body parsers & session
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'your_secret_key',
  resave: false,
  saveUninitialized: false,
}));

// Serve static files (including index.html)
app.use(express.static(path.join(__dirname, 'public')));
// Serve uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Configure Multer (keep original extension)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = uuid.v4() + ext.toLowerCase();
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

// Database
const db = new sqlite3.Database('./applications.db', (err) => {
  if (err) console.error("DB connection error:", err);
  else console.log('Connected to SQLite database.');
});

// Create tables if needed
db.serialize(() => {
  // applications
  db.run(`CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    firstname TEXT,
    lastname TEXT,
    email TEXT,
    documents TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // admins
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
  // mail_config
  db.run(`CREATE TABLE IF NOT EXISTS mail_config (
    id INTEGER PRIMARY KEY,
    host TEXT,
    port INTEGER,
    secure INTEGER,
    user TEXT,
    pass TEXT
  )`, () => {
    // Insert default config if none
    db.get("SELECT * FROM mail_config WHERE id = 1", [], (err2, row) => {
      if (!row) {
        db.run(`INSERT INTO mail_config (id, host, port, secure, user, pass)
                VALUES (1, 'smtp.example.com', 587, 0, 'username@example.com', 'password')`);
        console.log("Inserted default mail config.");
      }
    });
  });
});

// Load email templates from file or default
const templatesFile = path.join(__dirname, 'emailTemplates.json');
let emailTemplates = {
  thankYou: "Dear {{firstname}},\n\nThank you for your application. Your reference ID is {{id}}.",
  accepted: "Dear {{firstname}},\n\nCongratulations! Your application (ID: {{id}}) has been accepted and will be forwarded to the agency.",
  rejected: "Dear {{firstname}},\n\nWe regret to inform you that your application (ID: {{id}}) has been rejected."
};
if (fs.existsSync(templatesFile)) {
  emailTemplates = JSON.parse(fs.readFileSync(templatesFile));
}

// Function to get current mail config from db
async function getMailConfig() {
  return new Promise((resolve, reject) => {
    db.get("SELECT * FROM mail_config WHERE id = 1", [], (err, row) => {
      if (err) return reject(err);
      if (!row) return reject(new Error("No mail config found."));
      resolve(row);
    });
  });
}

// Send email via nodemailer
async function sendMail(to, subject, message) {
  try {
    const conf = await getMailConfig();
    let transporter = nodemailer.createTransport({
      host: conf.host,
      port: conf.port,
      secure: !!conf.secure,
      auth: {
        user: conf.user,
        pass: conf.pass
      }
    });
    await transporter.sendMail({
      from: conf.user,
      to,
      subject,
      text: message
    });
    console.log(`Email sent to ${to}`);
  } catch (err) {
    console.error(`Error sending email: ${err.message}`);
  }
}

//--- ROUTES ---

// Serve index
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Post => submit app
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
        // Send email
        const emailText = emailTemplates.thankYou
          .replace('{{firstname}}', firstname)
          .replace('{{id}}', id);
        await sendMail(email, 'Application Received', emailText);

        // Return valid JSON
        return res.json({
          success: true,
          message: "Application submitted successfully. Your reference ID is: " + id
        });
      }
    );
  } catch (ex) {
    console.error("Post / error:", ex);
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
  if (req.session && req.session.admin) return res.json({ loggedIn: true });
  res.json({ loggedIn: false });
});

// Filter & sort
app.get('/admin/api/applications', adminAuth, (req, res) => {
  const { status, sortBy } = req.query;
  let baseQuery = "SELECT * FROM applications";
  const conditions = [];
  const params = [];

  // status filter
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
app.post('/admin/api/application/:id/status', adminAuth, (req, res) => {
  const id = req.params.id;
  const { status } = req.body;
  if (!['accepted','rejected'].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  db.get("SELECT * FROM applications WHERE id = ?", [id], (err, row) => {
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
      let template = (status === 'accepted') ? emailTemplates.accepted : emailTemplates.rejected;
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

// Mail config: get & update host/port/secure/user/pass
app.get('/admin/api/mail-config', adminAuth, (req, res) => {
  db.get("SELECT * FROM mail_config WHERE id = 1", (err, row) => {
    if (err) {
      console.error("mail-config fetch error:", err);
      return res.status(500).json({ error: `DB error: ${err.message}` });
    }
    if (!row) {
      return res.json({
        host: "",
        port: 587,
        secure: false,
        user: "",
        pass: ""
      });
    }
    res.json({
      host: row.host,
      port: row.port,
      secure: !!row.secure,
      user: row.user,
      pass: row.pass
    });
  });
});
app.post('/admin/api/mail-config', adminAuth, (req, res) => {
  const { host, port, secure, user, pass } = req.body;
  db.run(
    "UPDATE mail_config SET host=?, port=?, secure=?, user=?, pass=? WHERE id = 1",
    [host, port, secure ? 1 : 0, user, pass],
    function(err) {
      if (err) {
        console.error("mail-config update error:", err);
        return res.status(500).json({ error: `DB error: ${err.message}` });
      }
      res.json({ message: "Mail config updated" });
    }
  );
});

app.listen(PORT, () => {
  console.log(`Server v1.1.2 running on port ${PORT}`);
});
