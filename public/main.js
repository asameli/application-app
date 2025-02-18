// main.js (v2.2.3)

// We'll define everything in a DOMContentLoaded listener so the elements exist
document.addEventListener('DOMContentLoaded', () => {
  // Dark mode toggle
  const darkModeToggle = document.getElementById('darkModeToggle');
  if (darkModeToggle) {
    darkModeToggle.addEventListener('click', (e) => {
      e.preventDefault();
      document.body.classList.toggle('dark');
    });
  }

  // Custom file uploader logic
  let selectedFiles = [];

  const addFileButton = document.getElementById('addFileButton');
  const fileInput = document.getElementById('fileInput');
  const fileList = document.getElementById('fileList');
  const applicationForm = document.getElementById('applicationForm');

  if (addFileButton) {
    addFileButton.addEventListener('click', () => {
      fileInput.click();
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        selectedFiles.push(file);
        updateFileList();
      }
      // Clear file input so re-selecting the same file is possible
      fileInput.value = "";
    });
  }

  function updateFileList() {
    if (!fileList) return;
    fileList.innerHTML = "";
    selectedFiles.forEach((file, index) => {
      const li = document.createElement('li');
      li.textContent = file.name + " ";
      // Remove button
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

  if (applicationForm) {
    applicationForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(applicationForm);
      // Append each selected file to FormData under "documents"
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
          applicationForm.reset();
          selectedFiles = [];
          updateFileList();
        } else {
          responseElem.innerHTML = data.message || "Error occurred";
        }
      } catch (err) {
        responseElem.innerHTML = "An error occurred: " + err.message;
      }
    });
  }
});
