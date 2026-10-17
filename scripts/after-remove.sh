#!/bin/bash

# Update GTK icon cache for hicolor theme
if hash gtk-update-icon-cache 2>/dev/null; then
    gtk-update-icon-cache -f -q /usr/share/icons/hicolor || true
fi

# Update desktop database
if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
