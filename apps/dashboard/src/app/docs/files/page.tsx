import type { Metadata } from "next";
import { Code, Note, Params } from "@/components/docs/code";
import { NextPage } from "@/components/docs/docs-nav";

export const metadata: Metadata = { title: "Files" };

export default function FilesDocsPage() {
  return (
    <>
      <header className="stack-2">
        <p className="eyebrow">SDK for Node.js</p>
        <h1 className="heading-3">Files</h1>
        <p className="title-2">
          Store files encrypted, list them, send them to your users and delete
          them. Big files stream: they are never held in memory.
        </p>
      </header>

      <h2 className="heading-5">Upload a file</h2>
      <p>
        <code>upload()</code> takes a path on disk, a Buffer, a stream, or a
        file from a form. It returns the file&apos;s details: keep its{" "}
        <code>id</code> (in your database, for example).
      </p>
      <Code title="upload.js">{`
// A file on disk: the name and type come from the path.
const file = await cloud.files.upload("./invoices/1027.pdf");
console.log(file.id, file.name, file.size);

// Text or bytes you made in your code.
await cloud.files.upload(Buffer.from("Hello"), { name: "hello.txt" });
`}</Code>

      <h2 className="heading-5">Upload from a form</h2>
      <p>
        HTML forms send files as <code>multipart/form-data</code>. Read them
        with <code>multer</code>, then pass <code>req.file</code> to the SDK.
      </p>
      <Code>{`npm install multer`}</Code>
      <Code title="server.js">{`
const multer = require("multer");
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } }); // 20 MB

app.post("/photos", upload.single("photo"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "Choose a photo." });
  const file = await cloud.files.upload(req.file);
  res.status(201).json(file);
});
`}</Code>
      <Code title="index.html">{`
<form action="/photos" method="post" enctype="multipart/form-data">
  <input type="file" name="photo" accept="image/*" required>
  <button type="submit">Upload</button>
</form>
`}</Code>

      <h2 className="heading-5">List and look up files</h2>
      <Code title="server.js">{`
const files = await cloud.files.list();      // every file, newest first
const one = await cloud.files.get(fileId);   // one file's details
const { usedBytes, limitBytes } = await cloud.files.usage();
`}</Code>
      <Params
        rows={[
          [
            "id",
            "string",
            "The file's ID: use it to get, send or delete the file.",
          ],
          ["name", "string or null", "The name it was uploaded with."],
          ["contentType", "string", "Its type, like image/png."],
          ["size", "number", "Its size in bytes."],
          ["createdAt", "string", "When it was uploaded (ISO 8601)."],
        ]}
      />

      <h2 className="heading-5">Send a file to the browser</h2>
      <p>
        <code>send(res, id)</code> streams the file to your user as a download,
        with its original name.
      </p>
      <Code title="server.js">{`
app.get("/files/:id", async (req, res) => {
  await cloud.files.send(res, req.params.id);
});
`}</Code>
      <Note tone="warning">
        Check that the user may see the file before you send it, for example
        that it belongs to their order. The SDK knows your workspace, not your
        users.
      </Note>

      <h2 className="heading-5">Save a file on your server, or stream it</h2>
      <Code title="server.js">{`
await cloud.files.download(fileId, "./copies/1027.pdf");

const stream = await cloud.files.stream(fileId); // a Node.js Readable
`}</Code>

      <h2 className="heading-5">Delete a file</h2>
      <Code title="server.js">{`
await cloud.files.delete(fileId);
`}</Code>
      <p>
        Its key is destroyed first, so it can never be read again, even from an
        old copy.
      </p>

      <h2 className="heading-5">Errors you may see</h2>
      <Params
        rows={[
          ["NOT_FOUND", "404", "No file with that ID in your workspace."],
          [
            "PAYLOAD_TOO_LARGE",
            "413",
            "The file is over the platform's upload limit.",
          ],
          [
            "STORAGE_QUOTA_EXCEEDED",
            "413",
            "Your workspace's storage is full: delete files first.",
          ],
          [
            "SECRETS_SEALED",
            "503",
            "The vault is sealed, so files can't be encrypted or decrypted yet.",
          ],
          ["FILE_NOT_FOUND", "0", "upload() got a path with no file at it."],
        ]}
      />

      <NextPage current="/docs/files" />
    </>
  );
}
