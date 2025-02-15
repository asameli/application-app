// server.js

const express = require('express');
const session = require('express-session');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const uuid = require('uuid');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// Default admin credentials
const DEFAULT_ADMIN_USERNAME = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'adminpass';

// Parse URL-encoded and JSON bodies
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Session setup for admin authentication
app.use(session({
  secret: 'your_secret_key', // Replace with an environment variable in production
  resave: false,
  saveUninitialized: false,
}));

// Serve static files (including index.html) from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Configure Multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Setup SQLite database
const db = new sqlite3.Database('./applications.db', (err) => {
  if (err) console.error("DB connection error:", err);
  else console.log('Connected to SQLite database.');
});

// Create the applications table if it does not exist
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    firstname TEXT,
    lastname TEXT,
    email TEXT,
    documents TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, (err) => {
    if (err) {
      console.error("DB table creation error:", err);
    }
  });
});

// Load email templates from a JSON file or use defaults
const templatesFile = path.join(__dirname, 'emailTemplates.json');
let emailTemplates = {
  thankYou: "Dear {{firstname}},\n\nThank you for your application. Your reference ID is {{id}}.",
  accepted: "Dear {{firstname}},\n\nCongratulations! Your application (ID: {{id}}) has been accepted and will be forwarded to the agency.",
  rejected: "Dear {{firstname}},\n\nWe regret to inform you that your application (ID: {{id}}) has been rejected."
};
if (fs.existsSync(templatesFile)) {
  emailTemplates = JSON.parse(fs.readFileSync(templatesFile));
}

// Function to send email using Plesk's internal mailer
function sendMail(to, subject, message) {
  const mailCommand = `echo "${message}" | mail -s "${subject}" ${to}`;
  exec(mailCommand, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error sending email: ${error.message}`);
    } else {
      console.log(`Email sent to ${to}`);
    }
  });
}

//-------------------------------------------------------------
// ROUTES
//-------------------------------------------------------------

// GET / => Serve the main page (index.html)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// POST / => Handle form submission
app.post('/', upload.array('documents', 10), (req, res) => {
  const { firstname, lastname, email } = req.body;
  const id = uuid.v4();
  const documentPaths = req.files.map(file => file.path);
  const documentsJSON = JSON.stringify(documentPaths);

  db.run(
    `INSERT INTO applications (id, firstname, lastname, email, documents)
     VALUES (?, ?, ?, ?, ?)`,
    [id, firstname, lastname, email, documentsJSON],
    function(err) {
      if (err) {
        console.error("DB insert error:", err);
        return res.status(500).send(`Database error: ${err.message}`);
      }
      // Send automated thank-you email
      const emailText = emailTemplates.thankYou
        .replace('{{firstname}}', firstname)
        .replace('{{id}}', id);
      sendMail(email, 'Application Received', emailText);

      res.send("Application submitted successfully. Your reference ID is: " + id);
    }
  );
});

// Admin login endpoint
app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  // Use the default admin credentials
  if (username === DEFAULT_ADMIN_USERNAME && password === DEFAULT_ADMIN_PASSWORD) {
    req.session.admin = username;
    return res.redirect('/admin/dashboard.html');
  }
  res.redirect('/admin/login.html?error=Invalid credentials');
});

// Admin logout endpoint
app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login.html');
});

// Middleware to protect admin routes
function adminAuth(req, res, next) {
  if (req.session && req.session.admin) {
    return next();
  }
  return res.redirect('/admin/login.html');
}

// API: Return if admin is logged in
app.get('/admin/api/status', (req, res) => {
  if (req.session && req.session.admin) {
    return res.json({ loggedIn: true });
  }
  return res.json({ loggedIn: false });
});

// API: Retrieve all applications for the admin dashboard
// Show newest first
app.get('/admin/api/applications', adminAuth, (req, res) => {
  db.all("SELECT * FROM applications ORDER BY created_at DESC", [], (err, rows) => {
    if (err) {
      console.error("DB fetch error (list apps):", err);
      return res.status(500).json({ error: `Database error: ${err.message}` });
    }
    res.json(rows);
  });
});

// API: Update application status (accepted or rejected) and send corresponding email
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
      // Send acceptance or rejection email using the updated template
      let template = status === 'accepted' ? emailTemplates.accepted : emailTemplates.rejected;
      let emailText = template
        .replace('{{firstname}}', row.firstname)
        .replace('{{id}}', id);
      sendMail(row.email, 'Application ' + status.charAt(0).toUpperCase() + status.slice(1), emailText);
      res.json({ message: "Status updated and email sent" });
    });
  });
});

// API: Delete application
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

// API: Get the total count of applications
app.get('/admin/api/count', adminAuth, (req, res) => {
  db.get("SELECT COUNT(*) as count FROM applications", (err, row) => {
    if (err) {
      console.error("DB count error:", err);
      return res.status(500).json({ error: `Database error: ${err.message}` });
    }
    res.json(row);
  });
});

// API: Get and update email templates
app.get('/admin/api/templates', adminAuth, (req, res) => {
  res.json(emailTemplates);
});

app.post('/admin/api/templates', adminAuth, (req, res) => {
  emailTemplates = req.body;
  fs.writeFileSync(templatesFile, JSON.stringify(emailTemplates, null, 2));
  res.json({ message: "Templates updated" });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
