"""
Copyright Pure Storage, Inc. 2020. All Rights Reserved
usage: pure1_api_client.py [-h] [-p PASSWORD] [-o OUTPUT]
                           id private_key_file
Retrieves an Access Token for Pure1 Public API
positional arguments:
  id                    application Id displayed on the Pure1 API Registration
                        page (i.e. pure1:apikey:dssf2331sd)
  private_key_file      path to the private key
optional arguments:
  -h, --help            show this help message and exit
  -p PASSWORD, --password PASSWORD
                        use if private key is encrypted (or use keyboard
                        prompt)
  -o OUTPUT, --output OUTPUT
                        write the access token to a file
"""

from argparse import ArgumentParser
from time import time
from paramiko import RSAKey, ssh_exception
from getpass import getpass
from io import StringIO
import requests
import warnings
import json
import jwt
import sys


def fatal(message):
    print('Error: {}'.format(message), file=sys.stderr)
    sys.exit(1)


# Token Exchange requires a JWT in the Authorization Bearer header with this format
def generate_id_token(iss, private_key, expire_seconds=31556952):
    new_jwt = jwt.encode({'iss': iss, 'iat': int(time()), 'exp': int(time()) + expire_seconds},
                         private_key, algorithm='RS256')
    # python3 jwt returns bytes, so we need to decode to string
    return new_jwt.decode()



# Load the private key from a file and decrypt if necessary
def get_private_key(file_name, password=None):
    try:
        rsa_key = RSAKey.from_private_key_file(file_name, password)
    except ssh_exception.PasswordRequiredException:
        password = getpass(prompt="Private key password: ")
        return get_private_key(file_name, password)
    except ssh_exception.SSHException:
        fatal('Invalid private key password')
    except FileNotFoundError:
        fatal('Could not find private key file')
    with StringIO() as buf:
        rsa_key.write_private_key(buf)
        return buf.getvalue()


def main():
    # Command-line arguments
    parser = ArgumentParser(description="Retrieves an Access Token for Pure1 Public API")
    parser.add_argument('id', type=str, help="application Id displayed on the Pure1 API Registration page"
                                             " (i.e. pure1:apikey:dssf2331sd)")
    parser.add_argument('private_key_file', type=str, help="path to the private key")
    parser.add_argument('-p', '--password', type=str, help="use if private key is encrypted (or use keyboard prompt)")
    parser.add_argument('-o', '--output', type=str, help="write the access token to a file")
    args = parser.parse_args()

    # Generate a new JWT using id and private key
    pri_key = get_private_key(args.private_key_file, args.password)
    id_token = generate_id_token(args.id, pri_key)
    print(id_token)


if __name__ == '__main__':
    main()