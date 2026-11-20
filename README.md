# Protecting Under the Hard Hat

[TODO] Description

## 🛠️ Tech Stack

| Component           | Technology            |
| ------------------- | --------------------- |
| Frontend            | Vanilla HTML, CSS, JS |
| Backend: Serverless | AWS Lambda            |
| Backend: Storage    | AWS S3; Google Drive  |

## 📂 Repo Structure

[TODO]

```
src/
    backend/
        generate_csv/           # Lambda func: Convert JSON data to CSV
            cleaning.js             # Clean JSON (drop, rename, reorder, etc.)
            index.js                # Main driver
            util.js                 # Utility functions
        process_response/       # Lambda func: Handle HTTP request + store response
            index.js                # Main driver
            test-input.js           # Input to test Lambda func when deploying
        upload_to_drive/        # Lambda func: Sync S3 contents with Google Drive
            drive.js                # Google Drive utility functions
            index.js                # Main driver
        deploy.sh               # Lambda function deployment script
    # [TODO] all frontend
    frontend_vanilla/
        questionnaire/
        static/
        ExampleOutput.json
        index.html
    util/
        questions-json-to-csv/  # Convert questions JSON to human-readable CSV
            main.py
            spec.md                 # Code specs for AI
```

Additionally, `generate_csv/`, `process_response/`, and `upload_to_drive/` each contain:

- `private/`: `.env` and credentials
- `package.json`: NPM packages needed

## ⚙️ Setup

[TODO]

Setup is only required for the **backend**:

Install AWS CLI

Install NPM packages for all the Lambda functions:

```bash
npm install --prefix ./src/backend/generate_csv
npm install --prefix ./src/backend/process_response
npm install --prefix ./src/backend/upload_to_drive
```

NPM package install for each Lambda function

Create a `private/` directory in each Lambda function to hold `.env` and credentials:

```bash
mkdir ./src/backend/generate_csv/private/ \
mkdir ./src/backend/process_response/private/ \
mkdir ./src/backend/upload_to_drive/private/ \
```

Set up `.env` files for each Lambda function:

```bash
cp ./src/backend/generate_csv/private/.env.example ./src/backend/generate_csv/private/.env
cp ./src/backend/process_response/private/.env.example ./src/backend/process_response/private/.env
cp ./src/backend/upload_to_drive/private/.env.example ./src/backend/upload_to_drive/private/.env
```

Make sure to populate each environment variable with your corresponding values.

[TODO] Show how to set up Google Cloud

Download `service_account.json` from Google Cloud, and add it to `upload_to_drive/`.

## 💻 Frontend

[TODO]

### 🧱 Payload Structure

[TODO]

## 🗄️ Backend

[TODO]

### 🪣 S3 Bucket

[TODO]

### 🧮 Lambda Functions

[TODO]

To deploy a Lambda function, first log into AWS:

```bash
aws login
```

Follow the instructions to complete the login.

Then run `deploy.sh` with the corresponding Lambda function directory passed as an argument. For example:

```bash
cd ./src/backend &&
bash ./deploy.sh upload_to_drive/
```

> [!WARNING]
> You _must_ be inside the directory that `deploy.sh` is in for it to pick up the proper Lambda function. You _cannot_ use the path from any other directory.

[TODO] `deploy_list.txt` explanation.

#### 📦 `process_response`

[TODO]

#### 📤 `upload_to_drive`

[TODO]

#### 📈 `generate_csv`

[TODO]

### `download_from_drive`

- Must be Drive editors files (not .docx, .xlsx, etc., but native Docs, Sheets, etc.)

### 🌐 Amplify

- Config file: [`amplify.yml`](./amplify.yml)
- Amplify auto-updates when there are any changes in the frontend directory.

## 🪠 Utility

Various utility functions that don't really fit in with the frontend nor the backend.

### 📈 Questions JSON to CSV

- Converts the questions JSON file to human-readable CSV dictionary with:
  - Question ID and text
  - Question type (single- or multi-select)
  - Question required
  - Each option ID and text
- Bridges the gap between the compact ID-based payload format sent and human-readable full text.

## ⭐ Credits

- Krish A. Patel (backend) [Oct 2025-Present]
- Franco Giovannetti (frontend) [Oct 2025-Present]
