import fs from 'fs';
import path from 'path';

const logPath = 'C:\\Users\\Tarak Krishna\\.gemini\\antigravity-ide\\brain\\53e2207c-4e89-4382-9827-15925d4bd461\\.system_generated\\logs\\transcript.jsonl';
if (!fs.existsSync(logPath)) {
  console.log("Transcript not found at", logPath);
  process.exit(1);
}

const lines = fs.readFileSync(logPath, 'utf8').split('\n');
for (const line of lines) {
  if (!line.trim()) continue;
  try {
    const obj = JSON.parse(line);
    
    // Search in the content of completed steps or tool calls
    if (obj.content && (obj.content.includes("console") || obj.content.includes("Console") || obj.content.includes("Error") || obj.content.includes("error") || obj.content.includes("Failed") || obj.content.includes("failed"))) {
      if (obj.content.includes("Browser subagent result:") || obj.content.includes("console.log") || obj.content.includes("Uncaught")) {
        console.log(`STEP ${obj.step_index} (${obj.type}):`);
        console.log(obj.content.substring(0, 1500));
        console.log("-----------------------------------------");
      }
    }
  } catch (e) {
    // Ignore invalid JSON lines
  }
}
