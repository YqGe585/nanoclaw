---
name: add-ducc-tool
description: Add ducc (百度 Claude Code CLI) tool support to NanoClaw environment with proper HOME directory handling.
---

# Add Ducc Tool

This skill adds ducc (百度 Claude Code CLI) support to NanoClaw, handling the HOME directory issue that prevents ducc from finding login credentials in container environments.

## Problem

When running in NanoClaw's container environment, ducc fails because:
1. `HOME` is set to `/home/PaddleAgent/nanoclaw/data/sessions/cli-local` (isolation)
2. ducc login credentials are stored in `/root/.comate/login`
3. ducc cannot find the login credentials and asks for re-authentication

## Solution

Create a wrapper script that sets `HOME=/root` when running ducc, allowing it to find the login credentials.

## Phase 1: Create Wrapper Script

Create the ducc wrapper script in the project bin directory:

```bash
cat > bin/ducc << 'EOF'
#!/bin/bash
# Ducc wrapper for NanoClaw environment
# Handles HOME directory issue to find login credentials

unset CLAUDECODE
HOME=/root /root/.comate/baidu-cc/bin/ducc "$@"
EOF

chmod +x bin/ducc
```

## Phase 2: Verify Setup

Test that ducc works:

```bash
bin/ducc --help 2>&1 | head -5
```

Expected output should show ducc help, not "failed to read user login info".

## Phase 3: Usage

After setup, use ducc via the wrapper:

```bash
# Instead of:
# ducc --permission-mode bypassPermissions --print 'your prompt'

# Use:
bin/ducc --permission-mode bypassPermissions --print 'your prompt'
```

Or add to PATH:

```bash
export PATH="$PWD/bin:$PATH"
ducc --permission-mode bypassPermissions --print 'your prompt'
```

## After Setup

The wrapper script `bin/ducc` will:
- Set `HOME=/root` so ducc can find `/root/.comate/login`
- Unset `CLAUDECODE` to avoid conflicts
- Pass all arguments to the real ducc binary

## Troubleshooting

### "failed to read user login info"

If you still see this error:
1. Verify the wrapper is being used: `which ducc` should show `/path/to/nanoclaw/bin/ducc`
2. Check login exists: `ls -la /root/.comate/login`
3. If login is missing, run `ducc login` in your host terminal (outside NanoClaw)

### Version check error

If you see "Fail to get current client version":
```bash
mkdir -p /root/.comate-server/extensions/baidu.baidu-cc-2.1.63-rc.0/baidu-cc
echo "2.1.63-rc.0" > /root/.comate-server/extensions/baidu.baidu-cc-2.1.63-rc.0/baidu-cc/version
```

## Removal

To remove ducc support:
```bash
rm bin/ducc
```
