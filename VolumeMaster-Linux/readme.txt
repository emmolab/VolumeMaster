====================================================================
                              VolumeMaster
====================================================================

IMPORTANT NOTICE
====================================================================

Before using VolumeMaster, the following requirements must be met.

The CH340 USB-to-Serial drivers must be installed on your Linux system.
These drivers are required for communication with the VolumeMaster
appliance.

Some systems also require the user account to be a member of the
"dialout" group in order to access serial devices.

To add your user to the dialout group, run:

    sudo usermod -aG dialout <username>

You must log out and log back in for the change to take effect.


OVERVIEW
====================================================================

VolumeMaster is a Linux application that allows you to control a
VolumeMaster appliance directly from your system.

The application is distributed as an AppImage and is built using
PyInstaller and linuxdeploy. This allows it to run on most modern Linux
distributions without requiring installation.


FEATURES
====================================================================

Application Grouping
--------------------------------------------------------------------
Organize applications into logical groups for easier volume management.

Master Volume Control
--------------------------------------------------------------------
Adjust the master volume for all applications at once.

Profile Creation
--------------------------------------------------------------------
Create and switch between custom profiles for different workflows such
as Gaming, Music, or Work.


INSTALLATION
====================================================================

1) Download the latest VolumeMaster AppImage.

2) Make the AppImage executable:

       chmod +x VolumeMaster-*.AppImage

3) Run the application:

       ./VolumeMaster-*.AppImage


USAGE
====================================================================

Launch the application by executing the AppImage.

Create or select application groups.

Adjust the master volume or individual application volumes.

Create and switch between workflow profiles as needed.


DEVELOPING / BUILDING A NEW APPIMAGE
====================================================================

If you wish to develop and modify the app and want a new app image

Update the application logic in:

    main.py

Then run the build script:

    ./build-app-image.sh

This will rebuild the application and package it as an AppImage using
PyInstaller and linuxdeploy.


====================================================================
