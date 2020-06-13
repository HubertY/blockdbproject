const { mine, init, recoverTree, Get, Transfer, Verify, GetHeight, PushBlock } = require("./index.js");
const { config } = require("./hash.js");

let counter = 0;
function test(value, condition) {
    if (!(value === condition || (typeof condition === "function" && condition(value)))) {
        console.log(value);
        throw Error(`test ${counter} failed`);
    }
    else {
        console.log(`test ${counter} passed`);
    }
    counter++;
}

function deepComparator(obj) {
    return function (item) {
        return JSON.stringify(obj) === JSON.stringify(item);
    }
}


//this pretends to be a fellow server. we can configure it to feed the test server any data we want.
class TestPeer {
    async call(command, data) {
        this.lastReceived = { command, data };
        return new Promise((resolve) => {
            setTimeout(() => {
                resolve(this.replies[this.counter]);
                if (this.counter < this.replies.length - 1) { this.counter++ };
                if (this.cb) { this.cb() };
            }, this.delay)
        });
    }

    async queueReplies(replies, delay) {
        return new Promise((resolve) => {
            this.counter = 0;
            this.replies = replies;
            this.delay = delay;
            this.cb = resolve;
        });
    }

    constructor() {
        this.cb = null;
        this.counter = 0;
        this.replies = null;
        this.delay = 100;
        this.lastReceived = null;
    }
}

//replace the real peers with fake peers
const peer1 = new TestPeer();
init("1", [peer1]);

//reduce mining difficulty for testing
config.difficulty = 2;

async function runTests() {
    //test basic functionality
    test(Get({ UserID: "alice" }).Value, 1000);

    const transaction = { Type: 5, FromID: "alice", ToID: "bob", Value: 10, MiningFee: 5, UUID: "testid1" };
    peer1.queueReplies([{ Success: true }], 200);

    //test good transfer
    const transfer = Transfer(transaction);

    test(peer1.lastReceived, deepComparator({ command: "PushTransaction", data: transaction }));
    test((await transfer).Success, true);

    test(Get({ UserID: "alice" }).Value, 990);
    test(Get({ UserID: "bob" }).Value, 1005);

    //test various bad transfers
    let badtransactions =
        [{ Type: 5, FromID: "alice", ToID: "bob", Value: 0, MiningFee: 0, UUID: "testid2" },
        { Type: 5, FromID: "alice", ToID: "alice", Value: 100, MiningFee: 50, UUID: "testid3" },
        { Type: 5, FromID: "alice", ToID: "bob", Value: 2000, MiningFee: 100, UUID: "testid4" },
        { Type: 5, FromID: "alice", ToID: "bob", Value: 100, MiningFee: 100, UUID: "testid5" },
        { Type: 5, FromID: "alice", ToID: "bob", Value: 100, MiningFee: 50, UUID: "testid1" }];

    for (let t of badtransactions) {
        test((await Transfer(t)).Success, false);
    }

    //test verify says transfer in progress (unflushed)
    test(Verify(transaction), deepComparator({ Result: 1, BlockHash: null }));

    //test mining
    let block = null;
    while (!(block = (await mine())));

    //test next mine quits early (no pending transactions)
    test(await mine(), null);

    test(Get({ UserID: "alice" }).Value, 990);
    test(Get({ UserID: "bob" }).Value, 1005);

    let goodTransactions =
        [{ Type: 5, FromID: "alice", ToID: "bob", Value: 10, MiningFee: 5, UUID: "testid2" },
        { Type: 5, FromID: "alice", ToID: "bob", Value: 10, MiningFee: 5, UUID: "testid3" },
        { Type: 5, FromID: "alice", ToID: "bob", Value: 10, MiningFee: 5, UUID: "testid4" },
        { Type: 5, FromID: "alice", ToID: "bob", Value: 10, MiningFee: 5, UUID: "testid5" },
        { Type: 5, FromID: "alice", ToID: "bob", Value: 10, MiningFee: 5, UUID: "testid6" },
        { Type: 5, FromID: "alice", ToID: "bob", Value: 10, MiningFee: 5, UUID: "testid7" },
        { Type: 5, FromID: "alice", ToID: "bob", Value: 10, MiningFee: 5, UUID: "testid8" },
        { Type: 5, FromID: "alice", ToID: "bob", Value: 10, MiningFee: 5, UUID: "testid9" },
        { Type: 5, FromID: "alice", ToID: "bob", Value: 10, MiningFee: 5, UUID: "testid10" },
        { Type: 5, FromID: "alice", ToID: "bob", Value: 10, MiningFee: 5, UUID: "testid11" },
        { Type: 5, FromID: "alice", ToID: "bob", Value: 10, MiningFee: 5, UUID: "testid12" },
        { Type: 5, FromID: "alice", ToID: "bob", Value: 10, MiningFee: 5, UUID: "testid13" }];

    let blocks = [block]
    for (let i = 0; i < 9; i++) {
        await Transfer(goodTransactions[i]);
        while (!(blocks[i + 1] = (await mine())));
    }

    //test buried transaction is confirmed
    test(Verify(transaction), deepComparator({ Result: 2, BlockHash: blocks[1].PrevHash }));


    peer1.queueReplies([
        { Height: blocks[3].BlockID, LeafHash: blocks[4].PrevHash },
        { Json: JSON.stringify(blocks[3]) },
        { Json: JSON.stringify(blocks[2]) },
        { Json: JSON.stringify(blocks[1]) },
        { Json: JSON.stringify(blocks[0]) }], 100);
        
    //test tree recovery
    init("1", [peer1]);
    await recoverTree();
    test(GetHeight(), deepComparator({ Height: blocks[3].BlockID, LeafHash: blocks[4].PrevHash }));

    //mine some alternate blocks
    for (let i = 5; i < 7; i++) {
        await Transfer(goodTransactions[i]);
        while (!(await mine()));
    }

    peer1.queueReplies([
        { Json: JSON.stringify(blocks[7]) },
        { Json: JSON.stringify(blocks[6]) },
        { Json: JSON.stringify(blocks[5]) },
        { Json: JSON.stringify(blocks[4]) }], 100);

    //forcibly add a branch
    await PushBlock({Json: JSON.stringify(blocks[8])});
    
    //test best leaf is updated
    test(GetHeight(), deepComparator({ Height: blocks[8].BlockID, LeafHash: blocks[9].PrevHash }));
}

runTests();



