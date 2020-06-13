const _fs = require("fs");
const grpc = require("grpc");
const protoLoader = require("@grpc/proto-loader");
const {get_hash_string} = require("./hash.js");
const {BlockTree} = require("./blocktree.js");

let N = 50;


let dbproto = null;
let config = null;

let blocktree = new BlockTree();

//UUID -> transaction
let unflushed = new Map();

let peers = [];


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

/*
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
*/

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
async function getFirstValidResultFromPeers(command, args, timeout = 500, valid = () => true) {
    let done = false;
    return new Promise(async (resolve) => {
        for (let peer of peers) {
            peer.call(command, args).then((result) => {
                if (!done) {
                    if (valid(result)) {
                        done = true;
                        resolve(result);
                    }
                }
            });
        }
        setTimeout(() => {
            done = true;
            resolve(null);
        }, timeout);
    });
}


//send a command to all the peers and return an array of the results.
async function getCollatedResultsFromPeers(command, args, timeout = 500) {
    let done = false;
    return new Promise(async (resolve) => {
        results = [];
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
        setTimeout(() => {
            done = true;
            resolve(results);
        }, timeout);
    });
}

//Arrange the fields of a transaction in standard order and make sure it's in the correct format.
function standardizeTransaction(t){
    if(typeof t !== "object" || typeof t.Type !== "string" || 
    typeof t.FromID !== "string" || typeof t.ToID !== "string" || 
    typeof t.Value !== "number" || typeof t.MiningFee !== "number"|| typeof t.UUID !== "string"){
        return false;
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
function parseBlockString(str, hash = false){
    const data = JSON.parse(str);
    if(!data || typeof data.BlockID !== number || typeof data.PrevHash !== "string" ||
    !Array.isArray(data.Transactions) || typeof data.MinerId !== "string" || typeof data.Nonce !== "string"){
        return false;
    }
    for(let i = 0; i < data.Transactions.length; i++){
        data.Transactions[i] = standardizeTransaction(data.Transactions[i]);
        if(!data.Transactions[i]){
            return false;
        }
    }
    const ret = {
        BlockID: data.BlockID,
        PrevHash: data.PrevHash,
        Transactions: data.Transactions,
        MinerId: data.MinerId,
        Nonce: data.Nonce
    };
    if(hash){
        if(get_hash_string(JSON.stringify(ret)) !== hash){
            return false;
        }
    }
    return ret;
}

async function recoverBlock(hash){
    let block = false;
    await getFirstValidResultFromPeers("GetBlock", {BlockHash: hash}, 500, (result)=>{
        if(!result){
            return false;
        }
        block = parseBlockString(result, hash);
        return block;
    });
    return block;
}

async function recoverBranch(hash){
    if(blocktree.has(hash)){
        return true;
    }

    console.log(`beginning recovery of branch starting from block ${hash}`);

    const blocks = [];
    const hashes = [hash];

    let done = false;
    while(true){
        let hash = hashes[hashes.length-1];
        let block = await recoverBlock(hash);
        if(block){
            blocks.push(block);
            if(blocktree.has(block.PrevHash)){
                console.log("tree found, unrolling");
                break;
            }
            else{
                hashes.push(block.PrevHash);
            }
        }
        else{
            console.log(`...block ${hash} not found, dropping branch`);
            return false;
        }
    }
    for(let i = hashes.length-1; i--;){
        const success = blocktree.add(blocks[i], hashes[i]);
        if(!success){
            console.log(`...block ${hash} invalid, dropping rest of branch`);
            return false;
        }
    }
}

//chain recovery
async function recoverTree() {
    console.log("beginning full blockchain recovery");
    //ask all the peers for their leaf nodes
    let leaves = await getCollatedResultsFromPeers("GetHeight");
    if(leaves.length === 0){
        console.log("all the peers are down, trying again in 5 seconds");
        setTimeout(recoverTree, 5000);
        return false;
    }
    for(let leaf of leaves){
        await recoverBranch(leaf);
    }
    console.log("blockchain recovery complete");
}


function Get({ UserID }) {
    const state = blocktree.applyTransactions(unflushed);
    return { Value: state[UserID] || 1000 };
}

function Transfer(args = { Type, FromID, ToID, Value, MiningFee, UUID }) {
    if(blocktree.transactionUUIDs.has(UUID)){
        return { Success: false };
    }
    if(unflushed.has(UUID)){
        return { Success: false };
    }
    const state = blocktree.applyTransactions(unflushed.values());
    state = blocktree.applyTransactions(state, [args]);
    if(!state){
        return { Success: false };
    }
    unflushed.set(UUID, args);
    return { Success: true };
}

function Verify({ Type, FromID, ToID, Value, MiningFee, UUID }) {
    return { Result: 0, BlockHash: ":)" };
}

function GetHeight() {
    return { Height: blocktree.bestHeight, LeafHash: blocktree.bestLeaf };
}

function GetBlock({BlockHash}) {
    const block = blocktree.blocks[BlockHash];
    return {Json: block ? JSON.stringify(block) : null}
}

function PushBlock() {

}

function PushTransaction() {

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
    const configFile = JSON.parse(fs.read("config.json", "utf8"))

    for (let key in configFile) {
        if (key !== "nservers") {
            if (key === id) {
                config = configFile[key];
                config.nservers = configFile.nservers;
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

    Transfer(call, callback) {
        let { FromID, ToID, Value } = call.request;
        callback(null, Transfer(FromID, ToID, Value));
    },
};


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