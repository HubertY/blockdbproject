const _fs = require("fs");
const grpc = require("grpc");
const protoLoader = require("@grpc/proto-loader");
const { get_hash_string, check_hash } = require("./hash.js");
const { BlockTree } = require("./blocktree.js");
const { allowedNodeEnvironmentFlags } = require("process");

let N = 50;


let dbproto = null;
let config = null;

let blocktree = new BlockTree();

//UUID -> transaction
let unflushed = new Map();

let peers = [];

let cached = null;
let cachedTransactionLength = null;
let cachedBlockHash = null;
function evaluateCurrentState() {
    if (blocktree.bestLeaf === cachedBlockHash && cachedTransactionLength === unflushed.size) {
        return cached;
    }
    else {
        for (let id of unflushed.keys()) {
            if (blocktree.findTransaction(id)) {
                unflushed.delete(id);
            }
        }
        let error = {};
        let ret = null;
        while (!(ret = blocktree.applyTransactions(unflushed.values(), blocktree.bestLeaf, error))) {
            unflushed.delete(error.failed.UUID);
        }
        cached = ret;
        cachedTransactionLength = unflushed.size;
        cachedBlockHash = blocktree.bestLeaf;
        return ret;
    }
}
//[0, 91] -> [!, |]
function chara(n) {
    let ret = String.fromCharCode(n + 33);
    if (ret === "\\") {
        return "}";
    }
    else if (ret === "\"") {
        return "~";
    }
    return ret;
}

let MAX = 92 * 92 * 92 * 92 * 92 * 92 * 92 * 92 - 1;
let x = Math.floor(Math.random() * MAX);
function nextNonce() {
    let ret = "";
    let n = x;
    for (let i = 8; i--;) {
        let q = n % 92;
        ret += chara(q);
        n -= q;
        n /= 92;
    }
    x++;
    if (x > MAX) {
        x = 0;
    }
    return ret;
}

let attempts = 0;
async function mine() {
    attempts++;
    evaluateCurrentState();
    if (unflushed.size === 0) {
        return;
    }
    let block = {
        BlockID: blocktree.bestHeight + 1,
        PrevHash: blocktree.bestLeaf,
        Transactions: [...unflushed.values()].slice(0, 50),
        MinerID: config.name,
        Nonce: nextNonce()
    }
    let s = JSON.stringify(block);
    if (check_hash(get_hash_string(s))) {
        attempts = 0;
        console.log(`successfully mined a new block with nonce ${block.Nonce} after ${attempts} attempts`);
        await PushBlock({ Json: s });
        await getFirstValidResultFromPeers("PushBlock", { Json: s });
    }
}

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


async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class Peer {
    async call(command, args) {
        return new Promise((resolve) => {
            this.rpc[command](args, resolve);
        });
    }
    constructor(ip) {
        this.ip = ip;
        this.rpc = new dbproto.BlockChainMiner(`${ip.ip}:${ip.port}`, grpc.credentials.createInsecure());
    }
}


//all these functions have no concurrency issues due to javascript event model

//send a command to all the peers and return the first valid result.
async function getFirstValidResultFromPeers(command, args, timeout = 500, valid = (result) => true) {
    let done = false;
    return new Promise(async (resolve) => {
        let counter = 0;
        for (let peer of peers) {
            peer.call(command, args).then((result) => {
                if (!done) {
                    counter++;
                    if (valid(result)) {
                        done = true;
                        resolve(result);
                    }
                    else {
                        if (counter === peers.length) {
                            done = true;
                            resolve(null);
                        }
                    }
                }
            });
        }
        await sleep(timeout);
        done = true;
        resolve(null);
    });
}


//send a command to all the peers and return an array of the results.
async function getCollatedResultsFromPeers(command, args, timeout = 500) {
    let done = false;
    return new Promise(async (resolve) => {
        let results = [];
        for (let peer of peers) {
            peer.call(command, args).then((result) => {
                if (!done) {
                    results.push(result);
                    if (results.length === peers.length) {
                        done = true;
                        resolve(results);
                    }
                }
            });
        }
        await sleep(timeout);
        done = true;
        resolve(results);
    });
}

//Arrange the fields of a transaction in standard order and make sure it's in the correct format.
function standardizeTransaction(t) {
    if (typeof t !== "object" || typeof t.Type !== "string" ||
        typeof t.FromID !== "string" || typeof t.ToID !== "string" ||
        typeof t.Value !== "number" || typeof t.MiningFee !== "number" || typeof t.UUID !== "string") {
        return null;
    }
    if (t.FromID === t.ToID) {
        return null;
    }
    return {
        Type: t.Type,
        FromID: t.FromID,
        ToID: t.ToID,
        Value: t.Value,
        MiningFee: t.MiningFee,
        UUID: t.UUID
    };
}

//sanitize a json string representing a block and return the block with the fields arranged in standard order.
//also optionally checks if the hash is ok
function parseBlockString(str, hash = null) {
    const data = JSON.parse(str);
    if (!data || typeof data.BlockID !== "number" || typeof data.PrevHash !== "string" ||
        !Array.isArray(data.Transactions) || typeof data.MinerId !== "string" || typeof data.Nonce !== "string") {
        return null;
    }
    for (let i = 0; i < data.Transactions.length; i++) {
        data.Transactions[i] = standardizeTransaction(data.Transactions[i]);
        if (!data.Transactions[i]) {
            return null;
        }
    }
    const ret = {
        BlockID: data.BlockID,
        PrevHash: data.PrevHash,
        Transactions: data.Transactions,
        MinerId: data.MinerId,
        Nonce: data.Nonce
    };
    if (hash) {
        if (get_hash_string(JSON.stringify(ret)) !== hash) {
            return null;
        }
    }
    return ret;
}

async function recoverBlock(hash) {
    let block = null;
    await getFirstValidResultFromPeers("GetBlock", { BlockHash: hash }, 500, (result) => {
        if (!result) {
            return false;
        }
        block = parseBlockString(result, hash);
        return !!block;
    });
    return block;
}

async function recoverBranch(hash) {
    if (blocktree.has(hash)) {
        return true;
    }

    console.log(`beginning recovery of branch starting from block ${hash}`);

    const blocks = [];
    const hashes = [hash];

    let done = false;
    while (true) {
        let hash = hashes[hashes.length - 1];
        let block = await recoverBlock(hash);
        if (block) {
            blocks.push(block);
            if (blocktree.has(block.PrevHash)) {
                console.log("tree found, unrolling");
                break;
            }
            else {
                hashes.push(block.PrevHash);
            }
        }
        else {
            console.log(`...block ${hash} not found, dropping branch`);
            return false;
        }
    }
    for (let i = hashes.length - 1; i--;) {
        const success = blocktree.add(blocks[i], hashes[i]);
        if (!success) {
            console.log(`...block ${hash} invalid, dropping rest of branch`);
            return false;
        }
    }
}

async function recoverTree() {
    console.log("beginning full blockchain recovery");
    //ask all the peers for their leaf nodes
    let leaves = await getCollatedResultsFromPeers("GetHeight");
    if (leaves.length === 0) {
        console.log("all the peers are down, trying again in 5 seconds");
        setTimeout(recoverTree, 5000);
        return false;
    }
    for (let leaf of leaves) {
        await recoverBranch(leaf);
    }
    console.log("blockchain recovery complete");
}


function Get({ UserID }) {
    return { Value: evaluateCurrentState()[UserID] || 1000 };
}

async function Transfer(args) {
    if (blocktree.findTransaction(args.UUID)) {
        return { Success: false };
    }
    if (unflushed.has(args.UUID)) {
        return { Success: false };
    }
    let state = blocktree.applyTransactions(evaluateCurrentState(), [args]);
    if (!state) {
        return { Success: false };
    }
    unflushed.set(args.UUID, args);

    const result = await getFirstValidResultFromPeers("PushTransaction", args, 500, (result) => result.Success);
    return { Success: !!result };
}

function Verify({ Type, FromID, ToID, Value, MiningFee, UUID }) {
    if (unflushed.has(UUID)) {
        let t = unflushed.get(UUID);
        if (t.Type === Type && t.FromID === FromID && t.ToID === ToID && t.Value === Value && t.MiningFee === MiningFee) {
            return { Result: 1, BlockHash: null };
        }
    }

    let search = blocktree.findTransaction(UUID);
    if (!search) {
        return { Result: 0, BlockHash: null };
    }
    else {
        let block = blocktree.blocks[search.hash];
        let t = block.Transactions[search.index];
        if (!(t.Type === Type && t.FromID === FromID && t.ToID === ToID && t.Value === Value && t.MiningFee === MiningFee)) {
            return { Result: 0, BlockHash: null };
        }
        if (blocktree.bestHeight - block.BlockID > 6) {
            return { Result: 2, BlockHash: search.hash };
        }
        else {
            return { Result: 1, BlockHash: search.hash };
        }
    }
}

function GetHeight() {
    return { Height: blocktree.bestHeight, LeafHash: blocktree.bestLeaf };
}

function GetBlock({ BlockHash }) {
    const block = blocktree.blocks[BlockHash];
    return { Json: block ? JSON.stringify(block) : null }
}

async function PushBlock({ Json }) {
    const block = parseBlockString(Json);
    if (!block) {
        return { Success: false };
    }
    const hash = get_hash_string(JSON.stringify(block));
    if (!check_hash(hash)) {
        return { Success: false };
    }
    if (blocktree.has(block.PrevHash)) {
        return { Success: blocktree.add(block, hash) };
    }
    else {
        if (await recoverBranch(block.PrevHash)) {
            return { Success: blocktree.add(block, hash) };
        }
        else {
            return { Success: false };
        }
    }
}

function PushTransaction(args) {
    const t = standardizeTransaction(args);
    if (!t) {
        return { Success: false };
    }
    if (blocktree.findTransaction(args.UUID)) {
        return { Success: false };
    }
    if (unflushed.has(args.UUID)) {
        return { Success: false };
    }
    let state = blocktree.applyTransactions(evaluateCurrentState(), [args]);
    if (!state) {
        return { Success: false };
    }
    unflushed.set(args.UUID, args);

    return { Success: true };
}

function Kill() {
    return { Success: true };
}

function init(id = "1", dataDirOverride = false, verbose = false) {
    const console = verbose ? global.console : { log: () => { } };

    dbproto = null;
    config = null;

    blocktree = new BlockTree();
    unflushed = new Map();

    peers = [];

    fs.dir = "";
    console.log("reading db.proto...")
    dbproto = grpc.loadPackageDefinition(protoLoader.loadSync("db.proto", { keepCase: true })).blockdb;
    if (!dbproto || !dbproto.BlockChainMiner || !dbproto.BlockChainMiner.service) {
        throw Error("db.proto is invalid");
    }
    console.log("...ok")

    console.log("reading config.json...");
    const configFile = JSON.parse(fs.read("config.json"))

    for (let key in configFile) {
        if (key !== "nservers") {
            if (key === id) {
                config = configFile[key];
                config.nservers = configFile.nservers;
                config.name = "Server";
                if (id.length < 2) {
                    config.name += "0";
                }
                config.name += id;
            }
            else {
                let ip = configFile[key];
                if (!ip.ip || !ip.port) {
                    throw Error("config.json is invalid");
                }
                peers.push(new Peer(`${ip.ip}:${ip.port}`));
            }
        }
    }
    if (!config || !config.ip || !config.port || !config.dataDir || !config.nservers) {
        throw Error("config.json is invalid");
    }

    console.log("...ok");

    config.dataDir = dataDirOverride || config.dataDir;


    console.log("purging data on disk");

    fs.dir = config.dataDir;
    for (let file of fs.ls()) {
        if (file.endsWith(".json") || file.endsWith(".tmp")) {
            fs.delete(file);
        }
    }
    if (!fs.exists("unflushed")) {
        fs.mkdir("unflushed");
    }
    fs.dir = config.dataDir + "unflushed/";
    for (let file of fs.ls()) {
        if (file.endsWith(".json") || file.endsWith(".tmp")) {
            fs.delete(file);
        }
    }

    console.log("...ok");
}

const gRPCInterface = {

    Get(call, callback) {
        callback(null, Get(call.request));
    },

    async Transfer(call, callback) {
        callback(null, await Transfer(call.request));
    },

    Verify(call, callback) {
        callback(null, Verify(call.request));
    },

    GetHeight(call, callback) {
        callback(null, GetHeight());
    },

    GetBlock(call, callback) {
        callback(null, GetBlock(call.request));
    },
    async PushBlock(call, callback) {
        callback(null, await PushBlock(call.request));
    },
    PushTransaction(call, callback) {
        callback(null, PushTransaction(call.request));
    },
    Kill(call, callback) {
        callback(null, Kill());
        process.exit();
    }
};

async function mineLoop() {
    while (true) {
        await mine();
        await sleep(10);
    }
}

function main(id = "1") {
    console.log(id);
    init(id, false, true);
    const server = new grpc.Server();
    server.addService(dbproto.BlockChainMiner.service, gRPCInterface);
    server.bind(`${config.ip}:${config.port}`, grpc.ServerCredentials.createInsecure());
    server.start();
    console.log(`listening on ${config.ip}:${config.port}`);

    recoverTree();
}

exports.main = main;