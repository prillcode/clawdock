# Discord Enhanced Media & Rich Output

Complete Discord integration enhancement: file uploads, document processing, and rich message formatting.

## Quick Reference

**Status**: Implementation Plan  
**Scope**: All 3 features implemented together  
**Estimated Effort**: 2-3 days development + 1 day testing  
**Dependencies**: poppler-utils, pandoc, imagemagick

**What's changing**:

- ✅ Users can upload files to Discord (attachments)
- ✅ Willis downloads and processes files (PDFs, images, archives, code)
- ✅ Responses use rich Discord embeds (structured, colored, with reactions)

## Overview

Currently Willis can only process text messages. This feature adds three major capabilities:

1. **File Upload Support** - Accept files uploaded to Discord channels, download them to the container, and make them available to Claude
2. **Document Processing** - Extract and analyze content from various file types (PDF, images, markdown, code)
3. **Rich Output** - Use Discord embeds and formatting for better presentation

All three features will be implemented together as a cohesive enhancement.

## Goals

1. **File Upload Support** - Accept files uploaded to Discord channels, download them to the container, and make them available to Claude
2. **Document Processing** - Extract and analyze content from various file types (PDF, images, markdown, code)
3. **Rich Output** - Use Discord embeds and formatting for better presentation
4. **Container Isolation** - Each channel's uploads are isolated to its own container workspace
5. **Unified Experience** - All three features work together seamlessly

## Use Cases

- "Here's my game design doc [attachment], can you review it?"
- "What's wrong with this code? [screenshot]"
- "Analyze this error log [.txt file]"
- Upload multiple files and ask Claude to compare them
- Share project files for contextual assistance

## Implementation Plan

All three features will be implemented together in a single comprehensive update.

### Feature 1: File Upload Handling

**Goal**: Download Discord attachments to container workspace

**Changes**:

- Detect `message.attachments` in Discord message handler (`src/channels/discord.ts`)
- Download files to `/workspace/group/uploads/<message-id>/`
- Pass file paths to Claude in the prompt
- Add cleanup for old uploads (configurable retention period)
- Track upload metadata in database

**File structure**:

```
groups/
  gamedev-assistant/
    uploads/
      <message-id-1>/
        screenshot.png
        error.log
        .metadata.json    # File info, upload time, retention
      <message-id-2>/
        design-doc.pdf
        .metadata.json
```

**Prompt format**:

```
[User uploaded 2 files]
- screenshot.png (image/png, 245KB) → /workspace/group/uploads/1234567890/screenshot.png
- error.log (text/plain, 12KB) → /workspace/group/uploads/1234567890/error.log

User message: "What's causing this error?"
```

**Configuration** (per-channel in `config/discord-groups.json`):

```json
{
  "uploads": {
    "enabled": true,
    "maxFileSize": 26214400,
    "maxFilesPerMessage": 10,
    "allowedTypes": ["*"],
    "retentionHours": 24,
    "autoCleanup": true
  }
}
```

**Database schema** (track uploads for cleanup):

```sql
CREATE TABLE uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  filename TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type TEXT,
  uploaded_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
```

### Feature 2: Document Processing

**Goal**: Extract and analyze content from various file types

**Supported formats**:

- **Images** (png, jpg, gif, webp): Use Claude's vision API
- **Text files** (txt, log, md, json, yaml, xml): Direct read
- **Code files** (js, ts, py, lua, rs, go, etc.): Syntax-aware processing
- **PDFs**: Extract text using `pdftotext` (poppler-utils)
- **Office docs** (docx, xlsx): Extract text using `pandoc` or `unoconv`
- **Archives** (zip, tar, tar.gz): Extract and list contents

**Implementation**:

1. **File type detection**:

```typescript
interface FileProcessor {
  canHandle(mimeType: string, extension: string): boolean;
  process(filePath: string): Promise<ProcessedFile>;
}

interface ProcessedFile {
  type: 'text' | 'image' | 'binary';
  content?: string; // For text/extracted content
  imageUrl?: string; // For images (Discord CDN URL)
  metadata: {
    pages?: number; // For PDFs
    dimensions?: { width: number; height: number }; // For images
    encoding?: string; // For text files
    extractedFrom?: string; // e.g., "PDF", "DOCX"
  };
  summary: string; // Human-readable description
}
```

2. **Processor implementations**:

- `ImageProcessor`: Pass Discord CDN URL directly to Claude vision API
- `TextProcessor`: Read file, detect encoding, pass content
- `PDFProcessor`: Run `pdftotext`, extract to temp file
- `ArchiveProcessor`: Extract to temp dir, list files
- `OfficeProcessor`: Convert to markdown/text using pandoc

3. **Container dependencies** (add to Dockerfile.base):

```dockerfile
RUN apt-get update && apt-get install -y \
    poppler-utils \     # PDF text extraction
    pandoc \            # Office doc conversion
    imagemagick \       # Image processing
    file \              # MIME type detection
    && rm -rf /var/lib/apt/lists/*
```

4. **Enhanced prompt format**:

```
[User uploaded: design-doc.pdf]
Type: PDF document
Size: 2.3 MB
Pages: 15
Extracted text saved to: /workspace/group/uploads/1234567890/design-doc.txt
Preview (first 500 chars):
"Game Design Document - BlockHaven
Version 1.2
Core Gameplay Loop:
Players gather resources by mining blocks..."

[User uploaded: screenshot.png]
Type: Image (PNG)
Size: 245 KB
Dimensions: 1920x1080
Image available for vision analysis at: https://cdn.discordapp.com/attachments/...

User message: "Summarize the key points from the design doc"
```

### Feature 3: Rich Response Formatting

**Goal**: Use Discord embeds and formatting for better presentation

**Features**:

- **Embeds** for structured responses (title, description, fields, colors)
- **Code blocks** with syntax highlighting (`language\ncode`)
- **Progress indicators** for long operations (reactions: ⏳ → ✅ → 🎉)
- **Error formatting** with clear visual indicators (🔴 for errors)
- **File metadata cards** when processing uploads
- **Multi-part responses** for long outputs (split into multiple embeds)

**Implementation**:

1. **Embed builder utility** (`src/utils/embed-builder.ts`):

```typescript
interface EmbedBuilder {
  setTitle(title: string): this;
  setDescription(desc: string): this;
  setColor(color: number): this;
  addField(name: string, value: string, inline?: boolean): this;
  setFooter(text: string): this;
  setTimestamp(): this;
  build(): Discord.MessageEmbed;
}

// Preset embed types
function createFileProcessedEmbed(file: ProcessedFile): Discord.MessageEmbed;
function createErrorEmbed(error: string): Discord.MessageEmbed;
function createSuccessEmbed(message: string): Discord.MessageEmbed;
```

2. **Response formatting** (`src/channels/discord.ts`):

```typescript
interface DiscordResponse {
  content?: string; // Plain text (for short responses)
  embeds?: Discord.MessageEmbed[]; // Rich embeds (for structured data)
  files?: Discord.MessageAttachment[]; // Generated files
  reactions?: string[]; // Emoji reactions to add
}

async function sendFormattedResponse(
  channel: Discord.TextChannel,
  response: DiscordResponse,
): Promise<void>;
```

3. **Smart formatting logic**:

- **Short text** (< 300 chars): Plain message
- **Long text** (> 300 chars): Embed with description
- **Code snippets**: Code blocks with language detection
- **File analysis**: Embed with file metadata card
- **Errors**: Red embed with error icon
- **Success**: Green embed with checkmark
- **Progress**: Update reactions (⏳ → ✅)

4. **Example responses**:

**File upload processed**:

```typescript
{
  embeds: [
    {
      color: 0x5865f2, // Discord blurple
      title: '📄 Files Processed',
      fields: [
        {
          name: 'design-doc.pdf',
          value: '✅ 15 pages extracted',
          inline: true,
        },
        { name: 'screenshot.png', value: '✅ Image analyzed', inline: true },
      ],
      footer: { text: 'Ready for analysis' },
      timestamp: new Date(),
    },
  ];
}
```

**Analysis result**:

```typescript
{
  embeds: [
    {
      color: 0x57f287, // Green
      title: 'Analysis Complete',
      description:
        "I've reviewed your design document. Here are the key findings:",
      fields: [
        {
          name: 'Strengths',
          value: '• Well-defined combat system\n• Clear progression mechanics',
        },
        {
          name: 'Areas to improve',
          value: '• Economy needs balancing\n• Art style requires detail',
        },
        {
          name: 'Next steps',
          value: 'Focus on the economy design in Section 4',
        },
      ],
      footer: { text: 'Analyzed in 8.3s' },
    },
  ];
}
```

**Error**:

```typescript
{
  embeds: [
    {
      color: 0xed4245, // Red
      title: '🔴 Processing Error',
      description:
        'Failed to extract text from PDF: File may be corrupted or password-protected',
      footer: {
        text: 'Try re-uploading the file or converting to a different format',
      },
    },
  ];
}
```

5. **Router integration** (`src/router.ts`):

```typescript
// Update router to handle rich formatting
export async function routeResponse(
  chatJid: string,
  response: string,
  metadata?: ResponseMetadata,
): Promise<void> {
  const channel = getChannel(chatJid);

  if (channel.type === 'discord') {
    const formatted = formatForDiscord(response, metadata);
    await sendDiscordResponse(chatJid, formatted);
  } else {
    // Plain text for other channels
    await sendPlainResponse(chatJid, response);
  }
}

interface ResponseMetadata {
  type?: 'success' | 'error' | 'info' | 'file_processed';
  files?: ProcessedFile[];
  codeBlocks?: { language: string; code: string }[];
  progress?: { current: number; total: number };
}
```

### Integration: All Features Working Together

**Example workflow**:

1. **User uploads files** → Feature 1 detects and downloads
2. **System processes files** → Feature 2 extracts content
3. **Shows processing status** → Feature 3 sends embed with ⏳ reaction
4. **Claude analyzes** → Receives extracted content in prompt
5. **Response formatted** → Feature 3 creates rich embed with results
6. **Updates reaction** → ⏳ → ✅

**Code flow**:

```typescript
// In discord.ts message handler
async function handleMessage(message: Discord.Message) {
  // Feature 1: Download attachments
  const uploadedFiles = await downloadAttachments(message);

  // Feature 3: Show processing indicator
  const statusMsg = await message.channel.send({
    embeds: [createProcessingEmbed(uploadedFiles.length)],
  });
  await statusMsg.react('⏳');

  // Feature 2: Process files
  const processedFiles = await Promise.all(
    uploadedFiles.map((file) => processFile(file)),
  );

  // Build prompt with file context
  const prompt = buildPromptWithFiles(message.content, processedFiles);

  // Send to agent
  const response = await invokeAgent(prompt);

  // Feature 3: Format and send response
  const formatted = formatResponse(response, { files: processedFiles });
  await message.channel.send(formatted);

  // Update status
  await statusMsg.react('✅');
  await statusMsg.delete({ timeout: 3000 });
}
```

### Advanced Features (Future Enhancements)

**Potential enhancements** (post-initial implementation):

- **Multi-file comparison**: "Compare these two designs [file1] [file2]"
- **File generation**: Claude creates files, Willis uploads them to Discord
- **Threaded responses**: Use Discord threads for complex multi-step analysis
- **Voice transcription**: Process voice messages using Whisper API
- **OCR**: Extract text from images using Tesseract
- **Interactive buttons**: Use Discord buttons for follow-up actions
- **Drag & drop to specific folders**: Upload to specific project directories
- **File versioning**: Track multiple versions of the same document

## Technical Details

### Discord API Integration

**Attachment object structure**:

```typescript
{
  id: string;
  filename: string;
  size: number;           // bytes
  url: string;            // CDN URL
  proxy_url: string;
  content_type?: string;  // MIME type
  width?: number;         // for images
  height?: number;        // for images
}
```

**Download implementation**:

```typescript
async function downloadAttachment(
  attachment: Discord.Attachment,
  destPath: string,
): Promise<string> {
  const response = await fetch(attachment.url);
  const buffer = await response.arrayBuffer();
  await fs.promises.writeFile(destPath, Buffer.from(buffer));
  return destPath;
}
```

### Container Modifications

**Dockerfile additions** (for PDF support):

```dockerfile
RUN apt-get update && apt-get install -y \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*
```

**Volume mounts** (already supported via existing mount system):

- Uploads directory is within `/workspace/group/` so already mounted
- No additional mounts needed

### Security Considerations

1. **File size limits** - Prevent disk space exhaustion
2. **File type validation** - Block executables, scripts (or sandbox them)
3. **Path traversal** - Ensure files stay within group workspace
4. **Cleanup** - Remove old uploads to prevent accumulation
5. **Malware scanning** - Optional: ClamAV integration for file scanning
6. **Rate limiting** - Prevent upload spam

### Configuration Schema

**Per-channel configuration** (in `config/discord-groups.json`):

```json
{
  "groups": {
    "gamedev-assistant": {
      "jid": "1471916406097445066",
      "trigger": "@mention",
      "uploads": {
        "enabled": true,
        "maxFileSize": 26214400, // 25MB in bytes
        "maxFilesPerMessage": 10,
        "allowedTypes": ["*"], // or ["image/*", "text/*", "application/pdf"]
        "retentionHours": 24,
        "autoCleanup": true
      }
    }
  }
}
```

**Global configuration** (in `.env`):

```bash
DISCORD_UPLOADS_ENABLED=true
DISCORD_MAX_UPLOAD_SIZE=26214400
DISCORD_UPLOAD_RETENTION_HOURS=24
DISCORD_ALLOWED_TYPES=*
```

## Task Breakdown

### Backend Tasks

**Database & Schema**:

- [ ] Add `uploads` table to schema (`src/db.ts`)
- [ ] Add upload tracking functions (insert, cleanup query)
- [ ] Add cleanup scheduler integration

**File Handling**:

- [ ] Create `src/file-handler.ts` module
- [ ] Implement `downloadAttachment(url, dest)` function
- [ ] Implement `createUploadDirectory(messageId)` function
- [ ] Implement `trackUpload(metadata)` database function
- [ ] Implement `cleanupExpiredUploads()` job
- [ ] Add file size validation
- [ ] Add file type validation (MIME + extension)
- [ ] Add path traversal protection

**Document Processing**:

- [ ] Create `src/processors/` directory
- [ ] Implement `FileProcessor` interface
- [ ] Implement `ImageProcessor` (pass CDN URL to vision API)
- [ ] Implement `TextProcessor` (read + encoding detection)
- [ ] Implement `PDFProcessor` (pdftotext extraction)
- [ ] Implement `ArchiveProcessor` (unzip + list)
- [ ] Implement `CodeProcessor` (syntax-aware reading)
- [ ] Add processor registry/factory
- [ ] Add file type detection utility
- [ ] Handle processing errors gracefully

**Rich Output**:

- [ ] Create `src/utils/embed-builder.ts`
- [ ] Implement `EmbedBuilder` class
- [ ] Implement preset embed creators (success, error, file processed)
- [ ] Add code block formatter
- [ ] Add response splitter (for long messages)
- [ ] Update `router.ts` to support Discord embeds
- [ ] Add reaction management utilities

**Discord Integration**:

- [ ] Update `src/channels/discord.ts` message handler
- [ ] Detect and iterate over `message.attachments`
- [ ] Download files sequentially or in parallel
- [ ] Show processing indicator (⏳ reaction)
- [ ] Process files and build enhanced prompt
- [ ] Send formatted response with embeds
- [ ] Update progress indicator (✅ reaction)
- [ ] Add error handling for each stage

**Configuration**:

- [ ] Add upload config to `config/discord-groups.json`
- [ ] Add global upload settings to `.env.example`
- [ ] Load and validate upload config per channel
- [ ] Add config defaults

**Container**:

- [ ] Update `container/Dockerfile.base` with dependencies
- [ ] Add poppler-utils (PDF extraction)
- [ ] Add pandoc (Office docs)
- [ ] Add imagemagick (image processing)
- [ ] Add file (MIME detection)
- [ ] Test container build

### Testing Tasks

**Unit Tests**:

- [ ] Test file download from Discord CDN
- [ ] Test file processor for each type
- [ ] Test embed builder
- [ ] Test path validation
- [ ] Test cleanup job
- [ ] Test configuration loading

**Integration Tests**:

- [ ] Test upload → download → process → respond flow
- [ ] Test multiple files in one message
- [ ] Test various file types (PDF, images, text, archives)
- [ ] Test file size limits
- [ ] Test retention and cleanup
- [ ] Test concurrent uploads from different channels

**Security Tests**:

- [ ] Test path traversal attempts
- [ ] Test malicious file names
- [ ] Test extremely large files
- [ ] Test file type spoofing (wrong extension)
- [ ] Test rate limiting

### Documentation Tasks

- [ ] Update README with file upload feature
- [ ] Add configuration guide for uploads
- [ ] Add troubleshooting section
- [ ] Add examples of supported file types
- [ ] Document embed formatting options
- [ ] Add security considerations

### Deployment Tasks

- [ ] Build updated container
- [ ] Deploy to test environment
- [ ] Enable for single test channel
- [ ] Monitor logs for errors
- [ ] Test with real files
- [ ] Adjust configuration based on testing
- [ ] Full deployment to production

## File Organization

```
/home/prill/dev/clawdock/
├── src/
│   ├── channels/discord.ts          # MODIFIED: Add attachment handling
│   ├── file-handler.ts               # NEW: File download & tracking
│   ├── processors/                   # NEW: Document processors
│   │   ├── index.ts                  # Processor registry
│   │   ├── base.ts                   # FileProcessor interface
│   │   ├── image.ts                  # ImageProcessor
│   │   ├── text.ts                   # TextProcessor
│   │   ├── pdf.ts                    # PDFProcessor
│   │   ├── archive.ts                # ArchiveProcessor
│   │   └── code.ts                   # CodeProcessor
│   ├── utils/
│   │   ├── embed-builder.ts          # NEW: Discord embed utilities
│   │   └── file-utils.ts             # NEW: MIME detection, validation
│   ├── router.ts                     # MODIFIED: Add embed support
│   ├── db.ts                         # MODIFIED: Add uploads table
│   └── task-scheduler.ts             # MODIFIED: Add cleanup job
├── container/
│   ├── Dockerfile.base               # MODIFIED: Add PDF/doc tools
│   └── agent-runner/src/index.ts     # No changes needed
├── groups/
│   └── <group-name>/
│       └── uploads/                  # NEW: Per-group uploads directory
│           └── <message-id>/
│               ├── <filename>
│               └── .metadata.json
├── config/
│   └── discord-groups.json           # MODIFIED: Add upload config
└── docs/
    └── DISCORD-ENHANCED-MEDIA.md     # This file
```

## Testing Plan

### Unit Tests

- File download from Discord CDN
- File type detection
- Path validation (no traversal)
- Cleanup job

### Integration Tests

- Upload file → Willis processes → Response with context
- Upload image → Claude analyzes via vision API
- Upload PDF → Extract text → Summarize
- Multiple files in one message
- Error handling (file too large, unsupported type)

### Manual Tests

- Upload various file types to Discord channel
- Verify files appear in container workspace
- Verify Claude can read/analyze them
- Verify cleanup after retention period
- Test with concurrent uploads from different channels

## Implementation Order

Since all three features are being implemented together, here's the recommended build order:

### Step 1: Foundation (Core Infrastructure)

- Database schema for upload tracking
- Upload directory structure in groups
- Configuration schema for per-channel upload settings
- File cleanup scheduler job

### Step 2: Feature 1 - File Upload Handling

- Detect attachments in Discord message handler
- Download files to group workspace
- Store metadata in database
- Pass file paths to Claude in prompt
- Test: Upload text file, verify Claude can read it

### Step 3: Feature 2 - Document Processing

- Add container dependencies (poppler-utils, pandoc)
- Implement file processors (PDF, images, archives)
- Extract content and generate summaries
- Enhanced prompt formatting with file metadata
- Test: Upload PDF, image, zip file - verify extraction

### Step 4: Feature 3 - Rich Output

- Create embed builder utility
- Implement response formatter
- Add progress indicators (reactions)
- Update router for Discord-specific formatting
- Test: Verify embeds, code blocks, error formatting

### Step 5: Integration & Polish

- Connect all three features in message handler
- Add error handling for each stage
- Implement cleanup job for old uploads
- Add logging and metrics
- Test: End-to-end workflow with multiple files

### Step 6: Testing & Validation

- Unit tests for each processor
- Integration tests for complete workflow
- Manual testing with various file types
- Performance testing with large files
- Security testing (malicious files, path traversal)

### Step 7: Documentation & Deployment

- Update user documentation
- Add configuration examples
- Deploy to test channel
- Monitor for issues
- Gather feedback

## Rollout Plan

1. **Development** - Implement all three features (Steps 1-5)
2. **Testing** - Comprehensive testing (Step 6)
3. **Soft launch** - Enable for gamedev-assistant channel only
4. **Monitor** - Watch logs, gather feedback (1-2 weeks)
5. **Iterate** - Fix issues, improve UX based on feedback
6. **Full rollout** - Enable for all Discord channels
7. **Advanced features** - Implement based on usage patterns

## Risks & Mitigations

| Risk                  | Impact | Mitigation                                          |
| --------------------- | ------ | --------------------------------------------------- |
| Disk space exhaustion | High   | File size limits, retention policy, cleanup job     |
| Malicious files       | Medium | File type validation, sandboxing, optional scanning |
| Download failures     | Low    | Retry logic, error messages to user                 |
| Processing overhead   | Medium | Queue large files, process async                    |
| Privacy concerns      | Low    | Files isolated per channel, cleanup policy          |

## Success Metrics

- **Adoption**: % of messages with attachments
- **File types**: Distribution of uploaded file types
- **Processing time**: Time from upload to first response
- **Error rate**: % of uploads that fail to process
- **User satisfaction**: Feedback on file handling UX

## Future Considerations

- **WhatsApp support**: Same file handling for WhatsApp media messages
- **Telegram support**: Similar implementation for Telegram
- **Cloud storage**: Integration with Google Drive, Dropbox for large files
- **Persistent uploads**: Option to keep important files beyond retention period
- **Upload gallery**: Web UI to browse channel uploads
