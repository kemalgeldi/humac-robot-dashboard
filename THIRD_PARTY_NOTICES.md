# Third-party notices

Bundled frontend assets are kept locally to avoid runtime CDN dependencies.

- ROSLIB.js 1.4.1: https://github.com/RobotWebTools/roslibjs/tree/1.4.1 (BSD-2-Clause).
  Downloaded bundle: https://cdn.jsdelivr.net/npm/roslib@1.4.1/build/roslib.js
  License: [static/vendor/roslib-LICENSE.txt](static/vendor/roslib-LICENSE.txt).
  The upstream browser bundle includes supporting dependencies and their embedded notices.
- Tailwind CSS 3.4.19: https://github.com/tailwindlabs/tailwindcss (MIT).
  Generated CSS: `static/styles.css`.
  License: [static/vendor/tailwindcss-LICENSE.txt](static/vendor/tailwindcss-LICENSE.txt).

SHA-256 of the bundled files:

```text
f148931a2fcbb117671b0bb7712b8f6fdca73798e9375557c5537e9b91d074a4  static/vendor/roslib-1.4.1.js
dcd5d9b11004083a12daf9ecae709a981d6b03d805f36e3eeee8356cf9663a3a  static/vendor/roslib-LICENSE.txt
60e0b68c0f35c078eef3a5d29419d0b03ff84ec1df9c3f9d6e39a519a5ae7985  static/vendor/tailwindcss-LICENSE.txt
```
