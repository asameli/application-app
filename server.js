// server.js
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const uuid = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Parse URL-encoded and JSON bodies
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Session setup for admin authentication
app.use(session({
  secret: 'your_secret_key', // Replace with an environment variable in production
  resave: false,
  saveUninitialized: false,
}));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Configure Multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Setup SQLite database
const db = new sqlite3.Database('./applications.db', (err) => {
  if (err) console.error(err.message);
  else console.log('Connected to SQLite database.');
});

// Create the applications table if it does not exist
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    firstname TEXT,
    lastname TEXT,
    email TEXT,
    documents TEXT,  -- Stored as a JSON array of file paths
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
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

// Configure Nodemailer (example uses Gmail; adjust as needed)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'your.email@gmail.com',    // Replace with your email
    pass: 'yourpassword'             // Replace with your email password or app-specific password
  }
});

// Endpoint: Submit application
app.post('/apply', upload.array('documents', 10), (req, res) => {
  const { firstname, lastname, email } = req.body;
  const id = uuid.v4();  // Generate a unique application ID
  const documentPaths = req.files.map(file => file.path);
  const documentsJSON = JSON.stringify(documentPaths);

  db.run(`INSERT INTO applications (id, firstname, lastname, email, documents) VALUES (?, ?, ?, ?, ?)`,
    [id, firstname, lastname, email, documentsJSON],
    function(err) {
      if (err) {
        console.error(err);
        return res.status(500).send("Database error.");
      }
      // Send automated thank you email
      let mailOptions = {
        from: 'your.email@gmail.com',
        to: email,
        subject: 'Application Received',
        text: emailTemplates.thankYou.replace('{{firstname}}', firstname).replace('{{id}}', id)
      };
      transporter.sendMail(mailOptions, (error, info) => {
        if (error) console.error(error);
        else console.log('Email sent: ' + info.response);
      });
      res.send("Application submitted successfully. Your reference ID is: " + id);
    }
  );
});

// Admin authentication middleware
function adminAuth(req, res, next) {
  if (req.session && req.session.admin) next();
  else res.redirect('/admin/login.html');
}

// Admin login endpoint
app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  // Hard-coded credentials for demonstration; in production use secure storage
  if (username === 'admin' && password === 'adminpass') {
    req.session.admin = username;
    res.redirect('/admin/dashboard.html');
  } else {
    res.redirect('/admin/login.html?error=Invalid credentials');
  }
});

// Admin logout endpoint
app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login.html');
});

// API: Retrieve all applications for the admin dashboard
app.get('/admin/api/applications', adminAuth, (req, res) => {
  db.all("SELECT * FROM applications", [], (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "Database error" });
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
    if (err || !row) return res.status(500).json({ error: "Application not found" });
    db.run("UPDATE applications SET status = ? WHERE id = ?", [status, id], function(err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "Database error" });
      }
      // Send acceptance or rejection email using the updated template
      let template = status === 'accepted' ? emailTemplates.accepted : emailTemplates.rejected;
      let emailText = template.replace('{{firstname}}', row.firstname).replace('{{id}}', id);
      let mailOptions = {
        from: 'your.email@gmail.com',
        to: row.email,
        subject: 'Application ' + status.charAt(0).toUpperCase() + status.slice(1),
        text: emailText
      };
      transporter.sendMail(mailOptions, (error, info) => {
        if (error) console.error(error);
        else console.log('Status update email sent: ' + info.response);
      });
      res.json({ message: "Status updated and email sent" });
    });
  });
});

// API: Get the total count of applications
app.get('/admin/api/count', adminAuth, (req, res) => {
  db.get("SELECT COUNT(*) as count FROM applications", (err, row) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "Database error" });
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
