const _fs = require("fs");
const grpc = require("grpc");
const protoLoader = require("@grpc/proto-loader");
const { get_hash_string, check_hash } = require("./hash.js");
const { BlockTree } = require("./blocktree.js");

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
                console.log(`dropping transaction ${id} (already found on tree)`);
                unflushed.delete(id);
            }
        }
        let error = {};
        let ret = null;
        while (!(ret = blocktree.applyTransactions(unflushed.values(), undefined, null, error))) {
            console.log(`dropping transaction ${error.failed.UUID} (not valid on best chain)`);
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
    //drops all inconsistent transactions
    evaluateCurrentState();
    if (unflushed.size === 0) {
        return null;
    }
    attempts++;
    let block = {
        BlockID: blocktree.bestHeight + 1,
        PrevHash: blocktree.bestLeaf,
        Transactions: [...unflushed.values()].slice(0, 50),
        MinerID: config.name,
        Nonce: nextNonce()
    }
    let s = JSON.stringify(block);
    let hash = get_hash_string(s);
    if (check_hash(hash)) {
        console.log(`successfully mined a new block ${hash} after ${attempts} attempts`);
        attempts = 0;
        await PushBlock({ Json: s });
        await getFirstValidResultFromPeers("PushBlock", { Json: s });
        return block;
    }
    return false;
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
            this.rpc[command](args, (err, data) => {
                if (err) {
                    resolve(null);
                }
                else {
                    resolve(data);
                }
            });
        });
    }
    constructor(name, ip) {
        this.name = name;
        this.ip = ip;
        this.rpc = new dbproto.BlockChainMiner(ip, grpc.credentials.createInsecure());
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
                    if (result && valid(result)) {
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
                    if (result) {
                        results.push(result);
                    }
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
    if (typeof t !== "object" || !(t.Type === 5 || t.Type === "Transfer") ||
        typeof t.FromID !== "string" || typeof t.ToID !== "string" ||
        typeof t.Value !== "number" || typeof t.MiningFee !== "number" || typeof t.UUID !== "string") {
        return null;
    }
    if (t.FromID === t.ToID) {
        return null;
    }
    if (t.MiningFee <= 0) {
        return null;
    }
    if (t.MiningFee >= t.Value) {
        return null;
    }
    return {
        Type: "Transfer",
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
        !Array.isArray(data.Transactions) || typeof data.MinerID !== "string" || typeof data.Nonce !== "string") {
            return null;
    }
    for (let i = 0; i < data.Transactions.length; i++) {
        data.Transactions[i] = standardizeTransaction(data.Transactions[i]);
        if (!data.Transactions[i]) {
            return null;
        }
    }
    if(data.MinerID){
        if(config.name !== data.MinerID && !peers.find(peer=>peer.name === data.MinerID)){
            console.log(`MinerID ${data.MinerID} is not a valid server`);
            return null;
        }
    }
    const ret = {
        BlockID: data.BlockID,
        PrevHash: data.PrevHash,
        Transactions: data.Transactions,
        MinerID: data.MinerID,
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
    console.log(`recovering block ${hash} from peers`);
    await getFirstValidResultFromPeers("GetBlock", { BlockHash: hash }, 500, (result) => {
        if (!result || !result.Json) {
            return false;
        }
        block = parseBlockString(result.Json, hash);
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
        if(!check_hash(hash)){
            console.log(`...block ${hash} doesn't start with enough 0s, dropping rest of branch`);
            return false;
        }
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
    for (let i = hashes.length; i--;) {
        const success = blocktree.add(blocks[i], hashes[i]);
        if (!success) {
            console.log(`...block ${hash} invalid, dropping rest of branch`);
            return false;
        }
    }
    return true;
}

async function recoverTree() {
    console.log("beginning full blockchain recovery");
    //ask all the peers for their leaf nodes
    let leaves = await getCollatedResultsFromPeers("GetHeight");
    while (leaves.length === 0) {
        console.log("all the peers are down, trying again in 5 seconds");
        await sleep(5000);
        leaves = await getCollatedResultsFromPeers("GetHeight");
    }
    for (let leaf of leaves) {
        await recoverBranch(leaf.LeafHash);
    }
    console.log("blockchain recovery complete");
    return true;
}


function Get({ UserID }) {
    return { Value: evaluateCurrentState()[UserID] || 1000 };
}

async function Transfer(args) {
    if (blocktree.findTransaction(args.UUID)) {
        console.log("transfer rejected (duplicate in tree)");
        return { Success: false };
    }
    if (unflushed.has(args.UUID)) {
        console.log("transfer rejected (duplicate)");
        return { Success: false };
    }
    let t = standardizeTransaction(args);
    if (!t) {
        console.log("transfer rejected (could not parse)");
        return { Success: false };
    }
    let state = blocktree.applyTransactions([t], evaluateCurrentState());
    if (!state) {
        console.log("transfer rejected (not allowed)");
        return { Success: false };
    }
    unflushed.set(args.UUID, t);

    const result = await getFirstValidResultFromPeers("PushTransaction", args, 1000, (result) => result.Success);
    return { Success: !!result };
}

function Verify({ Type, FromID, ToID, Value, MiningFee, UUID }) {
    if (unflushed.has(UUID)) {
        let t = unflushed.get(UUID);
        if (t.FromID === FromID && t.ToID === ToID && t.Value === Value && t.MiningFee === MiningFee) {
            return { Result: 1, BlockHash: null };
        }
        else {
            return { Result: 0, BlockHash: null };
        }
    }

    let search = blocktree.findTransaction(UUID);
    if (!search) {
        return { Result: 0, BlockHash: null };
    }
    else {
        let block = blocktree.blocks[search.hash];
        let t = block.Transactions[search.index];
        if (!(t.FromID === FromID && t.ToID === ToID && t.Value === Value && t.MiningFee === MiningFee)) {
            return { Result: 0, BlockHash: null };
        }
        if (blocktree.bestHeight - block.BlockID >= 6) {
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
        console.log("dropped pushed block (could not parse JSON)");
        return { Success: false };
    }
    const hash = get_hash_string(JSON.stringify(block));
    if (!check_hash(hash)) {
        console.log(`dropped pushed block (bad hash ${hash})`);
        return { Success: false };
    }
    if (blocktree.has(block.PrevHash)) {
        return { Success: blocktree.add(block, hash) };
    }
    else {
        console.log(`received dangling block ${hash}`);
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

function init(id = "1", peersOverride = null, verbose = false) {
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
                let name = "Server";
                if (key.length < 2) {
                    name += "0";
                }
                name += key;
                config.name = name;
            }
            else {
                let ip = configFile[key];
                if (!ip.ip || !ip.port) {
                    throw Error("config.json is invalid");
                }
                let name = "Server";
                if (key.length < 2) {
                    name += "0";
                }
                name += key;
                peers.push(new Peer(name, `${ip.ip}:${ip.port}`));
            }
        }
    }
    if (!config || !config.ip || !config.port || !config.dataDir) {
        throw Error("config.json is invalid");
    }

    peers = peersOverride || peers;

    console.log("...ok");


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
        await sleep(1);
    }
}

async function main(id = "1") {
    init(id, false, true);
    const server = new grpc.Server();
    server.addService(dbproto.BlockChainMiner.service, gRPCInterface);
    server.bind(`${config.ip}:${config.port}`, grpc.ServerCredentials.createInsecure());
    server.start();
    console.log(`listening on ${config.ip}:${config.port}`);

    await recoverTree();
    mineLoop();
}

exports.init = init;
exports.main = main;
exports.mine = mine;
exports.recoverTree = recoverTree;

exports.Get = Get;
exports.Transfer = Transfer;
exports.Verify = Verify;
exports.GetHeight = GetHeight;
exports.GetBlock = GetBlock;
exports.PushBlock = PushBlock;
exports.PushTransaction = PushTransaction;