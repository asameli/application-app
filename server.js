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
    documents TEXT,
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

// Endpoint: Submit application
app.post('/apply', upload.array('documents', 10), (req, res) => {
  const { firstname, lastname, email } = req.body;
  const id = uuid.v4();
  const documentPaths = req.files.map(file => file.path);
  const documentsJSON = JSON.stringify(documentPaths);

  db.run(`INSERT INTO applications (id, firstname, lastname, email, documents) VALUES (?, ?, ?, ?, ?)`,
    [id, firstname, lastname, email, documentsJSON],
    function(err) {
      if (err) {
        console.error(err);
        return res.status(500).send("Database error.");
      }
      const emailText = emailTemplates.thankYou.replace('{{firstname}}', firstname).replace('{{id}}', id);
      sendMail(email, 'Application Received', emailText);
      res.send("Application submitted successfully. Your reference ID is: " + id);
    }
  );
});

// API: Update application status (accepted or rejected) and send corresponding email
app.post('/admin/api/application/:id/status', (req, res) => {
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
      let template = status === 'accepted' ? emailTemplates.accepted : emailTemplates.rejected;
      let emailText = template.replace('{{firstname}}', row.firstname).replace('{{id}}', id);
      sendMail(row.email, 'Application ' + status.charAt(0).toUpperCase() + status.slice(1), emailText);
      res.json({ message: "Status updated and email sent" });
    });
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
