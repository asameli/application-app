// main.js (v2.2.0)

// Custom file uploader logic
let selectedFiles = [];

document.getElementById('addFileButton').addEventListener('click', () => {
  document.getElementById('fileInput').click();
});

document.getElementById('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    selectedFiles.push(file);
    updateFileList();
  }
  // Clear file input so that selecting the same file later will work
  e.target.value = "";
});

function updateFileList() {
  const fileList = document.getElementById('fileList');
  fileList.innerHTML = "";
  selectedFiles.forEach((file, index) => {
    const li = document.createElement('li');
    li.textContent = file.name;
    const removeBtn = document.createElement('button');
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener('click', () => {
      selectedFiles.splice(index, 1);
      updateFileList();
    });
    li.appendChild(removeBtn);
    fileList.appendChild(li);
  });
}

// Form submission with custom file uploader
document.getElementById('applicationForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const formData = new FormData(e.target);
  // Append each selected file to FormData under the same key "documents"
  selectedFiles.forEach(file => {
    formData.append("documents", file);
  });
  const responseElem = document.getElementById('response');
  responseElem.innerHTML = "Submitting...";
  try {
    const resp = await fetch("/", {
      method: "POST",
      body: formData,
    });
    if (!resp.ok) {
      const text = await resp.text();
      responseElem.innerHTML = text;
      return;
    }
    const data = await resp.json();
    if (data.success) {
      document.getElementById("overlayMessage").innerText = data.message;
      document.getElementById("successOverlay").style.display = "flex";
      responseElem.innerHTML = "";
      e.target.reset();
      selectedFiles = [];
      updateFileList();
    } else {
      responseElem.innerHTML = data.message || "Error occurred";
    }
  } catch (err) {
    responseElem.innerHTML = "An error occurred: " + err.message;
  }
});

// Toggle dark mode
document.getElementById('toggleDarkMode').addEventListener('click', () => {
  document.body.classList.toggle('dark');
});

// Admin panel and other functions remain defined in their respective pages.
