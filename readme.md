# Apartment Application Mailbox

A Node.js/Express application for managing apartment applications. This system provides a public frontend where applicants can fill in their information and upload documents, and a secure admin backend for managing, viewing, and updating the status of each application. Automated emails (thank-you, acceptance, and rejection) are sent to applicants, and email templates can be adjusted via the admin interface.

---

## Features

- **Responsive Frontend:**  
  Modern, responsive design with a dark mode toggle.

- **Secure Application Form:**  
  Applicants submit their first name, last name, email, and multiple document uploads.

- **Data Storage:**  
  All applications are stored in a SQLite database with a unique application ID.

- **Automated Email Notifications:**  
  Emails are sent upon submission and status updates (accepted or rejected) using Nodemailer.

- **Admin Backend:**  
  Secure, session-protected dashboard to view applications, update status, and customize email templates.

- **Deployment Script:**  
  A deployment script (`deploy.sh`) sets up the database and file structure.

- **GitHub Auto-Deployment on Plesk:**  
  Configure Plesk's Git extension to automatically deploy code updates from your GitHub repository.

---

## Getting Started

### Prerequisites

- **Node.js** (v12 or higher)
- **npm**
- **SQLite3**
- **Plesk Hosting Plan** with Node.js and Git support

---

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/your-repo.git
cd your-repo
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Environment Variables

Create a `.env` file in the root (if using dotenv) or set the variables via Plesk's Node.js settings. Example variables:

```env
PORT=3000
EMAIL_USER=your.email@gmail.com
EMAIL_PASS=yourpassword
SESSION_SECRET=your_secret_key
```

> **Note:** For production, ensure that sensitive information is stored securely and not hard-coded.

### 4. Run the Deployment Script

The `deploy.sh` script will create the necessary uploads directory and initialize the SQLite database.

```bash
chmod +x deploy.sh
./deploy.sh
```

---

## Running Locally

Start your application with:

```bash
node server.js
```

Then open your browser and navigate to `http://localhost:3000` to view the application.

---

## Project Structure

```
.
├── deploy.sh             # Deployment script to set up the database and directories
├── server.js             # Main server file (Express backend)
├── package.json          # Node.js project file with dependencies
├── emailTemplates.json   # Default email templates (if exists)
├── public
│   ├── index.html        # Frontend application form
│   ├── styles.css        # Application styles (includes dark mode)
│   ├── main.js           # Frontend JavaScript (toggle dark mode)
│   └── admin             # Admin backend files
│       ├── login.html
│       └── dashboard.html
└── README.md             # This file
```

---

## Deployment on Plesk

Follow these steps to deploy your application on Plesk with GitHub automatic deployment.

### 1. Enable Node.js Support

- Log in to your **Plesk** control panel.
- Select your domain or subdomain.
- Ensure that **Node.js support** is enabled for your domain.

### 2. Configure GitHub Automatic Deployment

Plesk offers a Git extension to streamline deployments:

1. **Access the Git Extension:**
   - In the Plesk panel, click on **Git**.

2. **Add Your Repository:**
   - Click **Add Repository**.
   - Choose **Remote Git hosting**.
   - Enter your GitHub repository URL (e.g., `https://github.com/yourusername/your-repo.git`).
   - Select the branch to deploy (e.g., `main`).

3. **Enable Automatic Deployment:**
   - Check the option for **Automatic Deployment** to trigger deployment on every push.
   - Save your settings.

### 3. Configure Node.js in Plesk

- Navigate to the **Node.js** settings for your domain.
- **Application Root:** Set it to the folder where your `server.js` is located.
- **Application Startup File:** Specify `server.js`.
- Click **NPM Install** to install dependencies.
- Set your environment variables (e.g., `PORT`, `EMAIL_USER`, `EMAIL_PASS`, `SESSION_SECRET`) in the Node.js settings.

### 4. Running the Deployment Script on Plesk

You may need to run `deploy.sh` to set up the database and directories:

- **Via SSH:**  
  Connect to your server via SSH and run:
  ```bash
  chmod +x deploy.sh
  ./deploy.sh
  ```
- **Scheduled Task:**  
  Alternatively, set up a scheduled task in Plesk to run the script.

### 5. Final Verification

- Open your domain in a browser to verify that the application is running.
- Test the form submission, file uploads, and email notifications.
- Push a change to GitHub and check that Plesk automatically deploys the update.

---

## Troubleshooting

- **Database Issues:**  
  Ensure that `applications.db` exists and is accessible by your Node.js process.

- **Email Issues:**  
  Verify that your email credentials are correct and configured properly (e.g., check Gmail settings if using Gmail).

- **File Uploads:**  
  Confirm that the `uploads/` directory exists and has appropriate write permissions.

---

## References

- [Express.js Documentation](https://expressjs.com/)
- [Nodemailer Documentation](https://nodemailer.com/about/)
- [Multer Documentation](https://github.com/expressjs/multer)
- [SQLite3 for Node.js](https://github.com/TryGhost/node-sqlite3)
- [Plesk Node.js Documentation](https://docs.plesk.com/en-US/obsidian/administrator-guide/nodejs/)
- [Plesk Git Integration](https://docs.plesk.com/en-US/obsidian/administrator-guide/git.75080/)

---

## License

This project is licensed under the MIT License.
