let { fs, Get, Put, Withdraw, Deposit, Transfer, LogLength, init, forceFlushFail } = require("./index.js");

let counter = 0;
function test(value, condition) {
    if (!(value === condition || (typeof condition === "function" && condition(value)))) {
        throw Error(`test ${counter} failed`);
    }
    else {
        console.log(`test ${counter} passed`);
    }
    counter++;
}

fs.rmrf("test");
fs.mkdir("test/");


init("test/");

//test basic operations
test(Put("alice", 10).Success, true);
test(Deposit("bob", 20).Success, true);

test(Withdraw("alice", 1).Success, true);
test(Withdraw("bob", 100).Success, false);

test(Transfer("bob", "alice", 5).Success, true);
test(Transfer("bob", "alice", 100).Success, false);

test(Get("alice").Value, 14);
test(Get("bob").Value, 15);

test(LogLength().Value, 4);

//test flushing to block
while (LogLength().Value < 50) {
    Put("carol", LogLength().Value);
}
Put("carol", 100);
test(LogLength().Value, 1);

//this causes file system writes to throw, simulating a crash.
fs.sabotage = true;
try {
    Deposit("throws", 10);
} catch (e) { };

fs.sabotage = false;


//test correct values are preserved on recovery.
init("test/");

test(Get("alice").Value, 14);
test(Get("bob").Value, 15);
test(Get("carol").Value, 100);

//test crash while flushing to block
while (LogLength().Value < 50) {
    Put("carol", LogLength().Value);
}
forceFlushFail.value = true;
try {
    Put("carol", 100);
}
catch (e) { };
fs.sabotage = false;
forceFlushFail.value = false;

//test correct values are preserved on recovery.
init("test/");

test(Get("alice").Value, 14);
test(Get("bob").Value, 15);
test(Get("carol").Value, 49);

//test recovered unflushed data is still there
test(LogLength().Value, 50);

//test next transaction causes flush
Put("carol", 100);
test(LogLength().Value, 1);
