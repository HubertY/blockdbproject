#!/bin/sh

#https://stackoverflow.com/questions/192249/how-do-i-parse-command-line-arguments-in-bash

ID=1

for i in "$@"
do
case $i in
    -i=*|--id=*)
    ID="${i#*=}"
    shift # past argument=value
    ;;
esac
done

exec node start.js ${ID}