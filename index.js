const _fs = require("fs");
const grpc = require("grpc");
const protoLoader = require("@grpc/proto-loader");

let N = 50;


let dbproto = null;
let config = null;

let dbdata = {};
let unflushed = [];
let totalTransactions = 0;

let forceFlushFail = {value: false};

//stolen from https://geedew.com/remove-a-directory-that-is-not-empty-in-nodejs/
function deleteFolderRecursive(path) {
    if (_fs.existsSync(path)) {
        _fs.readdirSync(path).forEach(function (file, index) {
            var curPath = path + "/" + file;
            if (_fs.lstatSync(curPath).isDirectory()) { // recurse
                deleteFolderRecursive(curPath);
            } else {
                _fs.unlinkSync(curPath);
            }
        });
        _fs.rmdirSync(path);
    }
};

//file system methods are expected to throw and crash the server if they fail.
const fs = {
    sabotage: false,
    dir: "",
    ls(path = "") {
        return _fs.readdirSync(`${fs.dir}${path}`);
    },
    exists(path) {
        return _fs.existsSync(`${fs.dir}${path}`);
    },
    mkdir(path) {
        _fs.mkdirSync(`${fs.dir}${path}`);
    },
    rmrf(path) {
        deleteFolderRecursive(path);
    },
    read(path) {
        return _fs.readFileSync(`${fs.dir}${path}`, { encoding: "utf8" });
    },
    write(path, data) {
        _fs.writeFileSync(`${fs.dir}${path}`, "");
        if (fs.sabotage) {
            _fs.writeFileSync(`${fs.dir}${path}.tmp`, "[corrupted placeholder data]");
            throw Error("write operation crashed for debugging purposes (fs.sabotage flag set)");
        }
        else {
            _fs.writeFileSync(`${fs.dir}${path}.tmp`, data);
            _fs.renameSync(`${fs.dir}${path}.tmp`, `${fs.dir}${path}`);
        }
    },
    delete(path) {
        _fs.unlinkSync(`${fs.dir}${path}`);
    },
    integrity(path, data) {
        return _fs.readFileSync(`${fs.dir}${path}`, { encoding: "utf8" }).length > 0;
    }
}

function readTransaction(data) {
    if (data.Type === "PUT") {
        return Put(data.UserID, data.Value, false).Success;
    }
    else if (data.Type === "WITHDRAW") {
        return Withdraw(data.UserID, data.Value, false).Success;
    }
    else if (data.Type === "DEPOSIT") {
        return Deposit(data.UserID, data.Value, false).Success;
    }
    else if (data.Type === "TRANSFER") {
        return Transfer(data.FromID, data.ToID, data.Value, false).Success;
    }
}

function writeTransaction(data) {
    if (unflushed.length === N) {
        flush();
    }
    fs.dir = config.dataDir + "unflushed/";
    fs.write(`${totalTransactions}.json`, JSON.stringify(data));
    totalTransactions++;
    unflushed.push(data);
}

function flush() {
    if(forceFlushFail.value){
        fs.sabotage = true;
    }
    if (unflushed.length !== N || totalTransactions % N !== 0) {
        console.log(unflushed.length, totalTransactions);
        throw Error("???");
    }

    const data = {
        BlockID: totalTransactions / N,
        PrevHash: "00000000",
        Transactions: unflushed,
        Nonce: "00000000"
    }

    fs.dir = config.dataDir;
    fs.write(`${data.BlockID}.json`, JSON.stringify(data));
    fs.dir = config.dataDir + "unflushed/";
    for (let file of fs.ls()) {
        fs.delete(file);
    }
    unflushed = [];
}

function reportTransactionFailure(type, reason, data){
    console.log(`${type} ${JSON.stringify(data)} failed; reason: ${reason}`)
};

function Get(id, log = true) {
    const ret = dbdata[id] ? dbdata[id] : 0;
    return { Value: ret };
}

function Put(id, amount, log = true) {
    amount = parseInt(amount);
    if (amount < 0) {
        reportTransactionFailure("PUT", "cannot set negative balance", {id, amount});
        return { Success: false };
    }
    dbdata[id] = amount;
    if (log) {
        writeTransaction({
            Type: "PUT",
            UserID: id,
            Value: amount
        });
    }
    return { Success: true };
}

function Withdraw(id, amount, log = true) {
    amount = parseInt(amount);
    let final = Get(id).Value - amount;
    if (amount < 0) {
        reportTransactionFailure("WITHDRAW", "cannot withdraw negative amount", {id, amount});
        return { Success: false };
    }
    if (final < 0) {
        reportTransactionFailure("WITHDRAW", "insufficient balance", {id, amount});
        return { Success: false };
    }
    dbdata[id] = final;
    if (log) {
        writeTransaction({
            Type: "WITHDRAW",
            UserID: id,
            Value: amount
        });
    }
    return { Success: true };
}

function Deposit(id, amount, log = true) {
    amount = parseInt(amount);
    let final = Get(id).Value + amount;
    if (amount < 0) {
        reportTransactionFailure("DEPOSIT", "cannot deposit negative amount", {id, amount});
        return { Success: false };
    }
    dbdata[id] = final;
    if (log) {
        writeTransaction({
            Type: "DEPOSIT",
            UserID: id,
            Value: amount
        });
    }
    return { Success: true };
}

function Transfer(from, to, amount, log = true) {
    amount = parseInt(amount);
    let fromFinal = Get(from).Value - amount;
    let toFinal = Get(to).Value + amount;
    if (amount < 0) {
        reportTransactionFailure("TRANSFER", "cannot transfer negative amount", {from, to, amount});
        return { Success: false };
    }
    if (fromFinal < 0) {
        reportTransactionFailure("TRANSFER", "sender has insufficient balance", {from, to, amount});
        return { Success: false };
    }
    dbdata[from] = fromFinal;
    dbdata[to] = toFinal
    if (log) {
        writeTransaction({
            Type: "TRANSFER",
            FromID: from,
            ToID: to,
            Value: amount
        });
    }
    return { Success: true };
}

function LogLength() {
    return { Value: unflushed.length };
}

// fs.writeFile('input.txt', 'Simply Easy Learning!', function (err) {
//     if (err) {
//         return console.error(err);
//     }
//     console.log("Data written successfully!");
//     console.log("Let's read newly written data");
//     // Read the newly written file and print all of its content on the console
//     fs.readFile('input.txt', function (err, data) {
//         if (err) {
//             return console.error(err);
//         }
//         console.log("Asynchronous read: " + data.toString());
//     });
// });

function init(dataDirOverride = false, verbose = false) {
    const console = verbose ? global.console : {log: ()=>{}};

    dbproto = null;
    config = null;

    dbdata = {};
    unflushed = [];
    totalTransactions = 0;

    fs.dir = "";
    console.log("reading db.proto...")
    dbproto = grpc.loadPackageDefinition(protoLoader.loadSync("db.proto", {keepCase: true})).blockdb;
    if (!dbproto || !dbproto.BlockDatabase || !dbproto.BlockDatabase.service) {
        throw Error("db.proto is invalid");
    }
    console.log("...ok")

    console.log("reading config.json...")
    config = JSON.parse(fs.read("config.json", "utf8"))[1];
    if (!config || !config.ip || !config.port || !config.dataDir) {
        throw Error("config.json is invalid");
    }
    console.log("...ok")

    config.dataDir = dataDirOverride || config.dataDir;

    fs.dir = config.dataDir;

    console.log("checking blockchain integrity");

    let numBlocks = 0;
    for (let file of fs.ls()) {
        if (file.endsWith(".json")) {
            numBlocks++;
        }
    }

    console.log(`...${numBlocks} blocks found`);
    for (let i = 1; i <= numBlocks; i++) {
        if (!fs.exists(`${i}.json`)) {
            throw Error(`block ${i} missing`);
        }
    }
    console.log("...ok");

    if (numBlocks) {
        console.log(`checking integrity of last block`);
        if (fs.integrity(`${numBlocks}.json`)) {
            console.log("...ok");
        }
        else {
            console.log("...last block is corrupt; discarding");
            fs.delete(`${numBlocks}.json`);
            numBlocks--;
        }
    }

    console.log(`loading ${numBlocks} blocks...`);
    for (let i = 1; i <= numBlocks; i++) {
        const data = JSON.parse(fs.read(`${i}.json`));
        if (!data || data.BlockID !== i || !data.Transactions || data.Transactions.length !== N) {
            console.log(data);
            throw Error(`block ${i} is corrupt`);
        }
        else {
            for (let transaction of data.Transactions) {
                if (!readTransaction(transaction)) {
                    console.log(transaction);
                    throw Error("bad transaction");
                }
            }
        }
    }
    totalTransactions = numBlocks * N;
    console.log("...done");

    console.log("cleaning .tmp files");
    for (let file of fs.ls()) {
        if (file.endsWith(".tmp")) {
            fs.delete(file);
        }
    }
    console.log("...done");

    if (!fs.exists("unflushed")) {
        fs.mkdir("unflushed");
    }

    fs.dir = config.dataDir + "unflushed/";
    console.log("cleaning already-flushed transactions");
    for (let file of fs.ls()) {
        if (file.endsWith(".json") && parseInt(file.split(".")[0]) < totalTransactions) {
            fs.delete(file);
        }
    }
    console.log("...done");

    console.log("checking transaction sequence integrity");

    let numUnflushed = 0;
    for (let file of fs.ls()) {
        if (file.endsWith(".json")) {
            numUnflushed++;
        }
    }

    console.log(`...${numUnflushed} transactions found`);
    for (let i = totalTransactions; i < totalTransactions + numUnflushed; i++) {
        if (!fs.exists(`${i}.json`)) {
            throw Error(`transaction ${i} missing`);
        }
    }
    console.log("...ok");

    if (numUnflushed) {
        console.log(`checking integrity of last transactions`);
        if (fs.integrity(`${totalTransactions + numUnflushed - 1}.json`)) {
            console.log("...ok");
        }
        else {
            console.log("...last transaction is corrupt; discarding");
            fs.delete(`${totalTransactions + numUnflushed - 1}.json`);
            numUnflushed--;
        }
    }

    console.log(`loading ${numUnflushed} transactions...`);
    for (let i = totalTransactions; i < totalTransactions + numUnflushed; i++) {
        const transaction = JSON.parse(fs.read(`${i}.json`));
        if (!readTransaction(transaction)) {
            console.log(transaction);
            throw Error("bad transaction");
        }
        unflushed.push(transaction);
    }
    totalTransactions += numUnflushed;

    console.log("...done");

    console.log("cleaning .tmp files");
    for (let file of fs.ls()) {
        if (file.endsWith(".tmp")) {
            fs.delete(file);
        }
    }
    console.log("...done");

    console.log(`init complete ${totalTransactions} total ${unflushed.length} unflushed`)
}

const gRPCInterface = {
    Get(call, callback){
        let {UserID} = call.request;
        callback(null, Get(UserID));
    },
    Put(call, callback){
        let {UserID, Value} = call.request;
        callback(null, Put(UserID, Value));
    },
    Withdraw(call, callback){
        let {UserID, Value} = call.request;
        callback(null, Withdraw(UserID, Value));
    },
    Deposit(call, callback){
        let {UserID, Value} = call.request;
        callback(null, Deposit(UserID, Value));
    },
    Transfer(call, callback){
        let {FromID, ToID, Value} = call.request;
        callback(null, Transfer(FromID, ToID, Value));
    },
    LogLength(call, callback){
        callback(null, LogLength());
    }
};


function main() {
    init(false, true);
    const server = new grpc.Server();
    server.addService(dbproto.BlockDatabase.service, gRPCInterface);
    server.bind(`${config.ip}:${config.port}`, grpc.ServerCredentials.createInsecure());
    server.start();
    console.log(`listening on ${config.ip}:${config.port}`);
}

exports.fs = fs;
exports.Get = Get;
exports.Put = Put;
exports.Withdraw = Withdraw;
exports.Deposit = Deposit;
exports.Transfer = Transfer;
exports.LogLength = LogLength;
exports.init = init;
exports.main = main;
exports.forceFlushFail = forceFlushFail;
