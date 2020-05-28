Requires node.js (``sudo apt-get install nodejs``)
Requires npm to install external libraries from the Internet, but ``start.sh`` should work immediately as libraries are already included. If it does't work run ``compile.sh``.

The key-value storage in memory is kept as a vanilla JavaScript object. The underlying implementation is a O(1) hashmap. Transient logs (not yet flushed) are stored in the ``dataDir/unflushed/`` directory.

To test: run ``test.sh``. Test code is located in ``test.js``.
