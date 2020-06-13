const sjcl = require("sjcl");

function get_hash_string(input){
    return sjcl.codec.hex.fromBits(get_hash_bytes(input));
}

function get_hash_bytes(input){
    return sjcl.hash.sha256.hash(input);
}

let config = {difficulty: 5}
function check_hash(hash){
    return hash.slice(0,config.difficulty) === "0000000000000000000000000000000000000000000000000000000000000000".slice(0,config.difficulty);
}

exports.get_hash_string = get_hash_string;
exports.check_hash = check_hash;
exports.config = config;