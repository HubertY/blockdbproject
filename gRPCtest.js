//call this while the server is running. 

const ip = '127.0.0.1:50051';

var grpc = require('grpc');
var protoLoader = require('@grpc/proto-loader');
var packageDefinition = protoLoader.loadSync(
    "db.proto",
    { keepCase: true, });
var proto = grpc.loadPackageDefinition(packageDefinition).blockdb;

let done = false;

var client = new proto.BlockDatabase(ip, grpc.credentials.createInsecure());

client.Get({ UserID: "alice", Value: 500 }, function (err, response) {
    console.log(response);
});
