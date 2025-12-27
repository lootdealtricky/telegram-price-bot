#!/usr/bin/env bash
# exit on error
set -o errexit

npm install
# Chrome ki zaroori cheezein install karne ke liye
apt-get update && apt-get install -y google-chrome-stable
