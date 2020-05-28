Requires node.js (``sudo apt-get install nodejs``).

Requires npm (``sudo apt-get install npm``) to install external libraries from the Internet, but ``start.sh`` should work immediately as libraries are already included. If it doesn't work run ``compile.sh``.

The key-value storage in memory is kept as a vanilla JavaScript object. The underlying implementation is a O(1) hashmap. Transient logs (not yet flushed) are stored in the ``dataDir/unflushed/`` directory.

To test: run ``test.sh``. Test code is located in ``test.js``. The test script uses ``test/`` as a working directory, overriding the config file.

Node.js runs on a single-threaded event loop. This means all synchronous functions are guaranteed not to be interrupted by other functions. The database transactions are all implemented synchronously, so incoming requests are processed sequentially and there are no concurrency problems. A multithreaded implementation doesn't make much sense since the threads would just block each other waiting for disk anyway.
