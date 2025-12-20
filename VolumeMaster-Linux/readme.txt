VolumeMaster

VolumeMaster is a Linux application that allows you to control your VolumeMaster appliance directly from your system.
The application is packaged as an AppImage using PyInstaller and linuxdeploy for easy installation and portability.

Features:

- Application Grouping: Organize applications into groups for easier volume management.
- Master Volume Control: Adjust the master volume for all applications at once.
- Profile Creation: Create and switch between custom profiles for different workflows, e.g., Gaming, Music, or Work.

Installation:

1. Download the latest VolumeMaster AppImage.
2. Make it executable:
   chmod +x VolumeMaster-*.AppImage
3. Run the AppImage:
   ./VolumeMaster-*.AppImage

Usage:

- Launch the app by running the AppImage file.
- Select or create application groups.
- Adjust the master volume or individual application volumes.
- Create and switch between workflow profiles for Gaming, Music, Work, etc.

Important Notice:

Some users may need to add their user to the 'dialout' group in order for the app to work properly.
To do so, run:
   sudo usermod -aG dialout <username>
Then log out and log back in for the changes to take effect.

Requirements:

- Linux system
- AppImage support (most modern distributions)
- Access to the VolumeMaster appliance
