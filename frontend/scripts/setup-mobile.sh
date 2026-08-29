#!/bin/bash

# Stellar Solar Grid - Mobile App Setup Script
# This script automates the initial Capacitor setup

set -e

echo "========================================="
echo "Stellar Solar Grid - Mobile App Setup"
echo "========================================="
echo ""

# Check if we're in the frontend directory
if [ ! -f "package.json" ]; then
  echo "Error: Please run this script from the frontend directory"
  exit 1
fi

# Step 1: Install Capacitor dependencies
echo "Step 1: Installing Capacitor dependencies..."
npm install --save \
  @capacitor/core \
  @capacitor/cli \
  @capacitor/app \
  @capacitor/haptics \
  @capacitor/keyboard \
  @capacitor/network \
  @capacitor/preferences \
  @capacitor/push-notifications \
  @capacitor/splash-screen \
  @capacitor/status-bar \
  @capawesome/capacitor-biometric-auth \
  @capawesome/capacitor-background-task \
  firebase

echo "✅ Capacitor dependencies installed"
echo ""

# Step 2: Backup and update package.json scripts
echo "Step 2: Updating package.json scripts..."
if [ -f "package.capacitor.json" ]; then
  # Merge scripts from package.capacitor.json
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const capPkg = JSON.parse(fs.readFileSync('package.capacitor.json', 'utf8'));
    pkg.scripts = { ...pkg.scripts, ...capPkg.scripts };
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
  "
  echo "✅ Scripts updated"
else
  echo "⚠️  package.capacitor.json not found, skipping script merge"
fi
echo ""

# Step 3: Initialize Capacitor
echo "Step 3: Initializing Capacitor..."
if [ ! -f "capacitor.config.ts" ]; then
  npx cap init "Stellar Solar Grid" "com.stellarsolargrid.app" --web-dir=out
  echo "✅ Capacitor initialized"
else
  echo "ℹ️  Capacitor already initialized, skipping..."
fi
echo ""

# Step 4: Build Next.js for export
echo "Step 4: Building Next.js app..."
npm run build
echo "✅ Next.js build complete"
echo ""

# Step 5: Add platforms
echo "Step 5: Adding native platforms..."

# Add iOS if on macOS
if [[ "$OSTYPE" == "darwin"* ]]; then
  if [ ! -d "ios" ]; then
    echo "Adding iOS platform..."
    npx cap add ios
    echo "✅ iOS platform added"
  else
    echo "ℹ️  iOS platform already exists, skipping..."
  fi
else
  echo "⚠️  Skipping iOS (macOS required)"
fi

# Add Android
if [ ! -d "android" ]; then
  echo "Adding Android platform..."
  npx cap add android
  echo "✅ Android platform added"
else
  echo "ℹ️  Android platform already exists, skipping..."
fi
echo ""

# Step 6: Initial sync
echo "Step 6: Syncing to native projects..."
npx cap sync
echo "✅ Sync complete"
echo ""

# Step 7: Setup instructions
echo "========================================="
echo "✅ Mobile app setup complete!"
echo "========================================="
echo ""
echo "Next steps:"
echo ""
echo "1. Configure Firebase:"
echo "   - Create project at console.firebase.google.com"
echo "   - Download GoogleService-Info.plist → ios/App/App/"
echo "   - Download google-services.json → android/app/"
echo ""
echo "2. Run on devices:"
echo "   iOS:     npm run capacitor:open:ios"
echo "   Android: npm run capacitor:open:android"
echo ""
echo "3. Read full documentation:"
echo "   ../MOBILE_APP_SETUP.md"
echo ""
echo "Happy coding! 🚀"
