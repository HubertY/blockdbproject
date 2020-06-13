Usage: ``start.sh --id=1``

Requires node.js (``sudo apt-get install nodejs``).

Requires npm (``sudo apt-get install npm``) to install external libraries from the Internet, but ``start.sh`` should work immediately as libraries are already included. If it doesn't work run ``compile.sh``.

The key-value storage in memory is kept as a vanilla JavaScript object. The underlying implementation is a O(1) hashmap.

To test: run ``test.sh``. Test code is located in ``test.js``. The test script instantiates only one server, overriding peer connection objects with fake peers.

Node.js runs on a single-threaded event loop. This means all synchronous blocks of code will not be interrupted by other Javascript. Tree transactions are synchronous, so no special concurrency considerations have to be made. The best leaf and the associated state are computed in a lazy manner.

When attempting to acquire a single block from its hash, we query all peers, take the first valid result and drop the rest. This is safe because we assume preimage attacks on the hash are impossible. When attempting to rebuild the whole tree we query all peers for leaf nodes and try to walk back to the root from every branch. We drop any blocks that cannot be connected back to the root. We also try to walk back to the root if we receive a block via ``PushBlock`` that isn't connected to anything. If a tentative branch cannot be connected to the root because of a bad or inaccesible block we just drop the whole branch.

We store the global state after each block together with the blocks themselves in order to allow both querying balances and connecting blocks anywhere on the tree in O(1) time. However in the worst case this results in O(n^2) memory usage. We could flush old blocks to the disk periodically or prune short branches, but these features are not currently implemented.

## Modifications to db.proto

Commands ``PushTransaction(Transaction)`` and `PushBlock(JsonBlockString) ` now return ``BooleanResponse`` instead of ``Null``, indicating that the command is acknowledged and whether or not the pushed data is new and valid information.

New command ``Kill(Null)`` returns ``{Success: true}`` to the client then immediately kills the server. Due to the nature of javascript's event model, ``Kill`` cannot corrupt disk writes.

## hash.js

We reimplement the hash interface provided for Go and Python in ``hash.js`` using SJCL SHA256. It functions identically to its counterparts except that it exposes a ``config.difficulty=5`` flag used for testing only.


