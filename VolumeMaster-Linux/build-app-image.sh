#!/bin/bash
set -e  # Exit on any error

# App metadata (customize these)
APP_NAME="VolumeMaster"          # Change to your app name
APP_VERSION="1.0"          # Optional version
EXEC_NAME="main"           # Name of the PyInstaller executable (from main.py)
DESKTOP_EXEC="main"        # Exec line in .desktop file

# Clean previous builds
rm -rf dist build AppDir *.AppImage *.spec venv *.desktop

# Step 1: Create and activate virtual environment
python3 -m venv venv
source venv/bin/activate

pip install -r requirements.txt

# Step 3: Build onefile executable
pyinstaller --onefile --name=$EXEC_NAME --add-data "icon.png:." main.py


# Deactivate venv
deactivate

# Step 4: Download linuxdeploy (x86_64)
wget -c https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-x86_64.AppImage
chmod +x linuxdeploy-x86_64.AppImage

# Step 5: Create a custom .desktop file with Icon matching the base name of your icon file
cat > ${APP_NAME}.desktop <<EOF
[Desktop Entry]
Type=Application
Name=$APP_NAME
Exec=$DESKTOP_EXEC %U
Icon=icon
Categories=Utility;
EOF

mkdir -p AppDir/usr/bin && cp icon.png AppDir/usr/bin/

# Step 6: Build AppImage
./linuxdeploy-x86_64.AppImage \
  --appdir AppDir \
  --executable dist/$EXEC_NAME \
  --icon-file icon.png \
  --desktop-file ${APP_NAME}.desktop \
  --output appimage

echo "AppImage created: $(ls *.AppImage)"
echo "Test it: ./*.AppImage"