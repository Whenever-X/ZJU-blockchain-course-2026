// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract LiquidityPositionNFT is ERC721, Ownable {
    uint256 public nextTokenId = 1;
    address public minter;
    mapping(uint256 => string) private _tokenURIs;

    constructor() ERC721("MiniDEX Liquidity Position", "MDLP") Ownable(msg.sender) {}

    function setMinter(address newMinter) external onlyOwner {
        require(newMinter != address(0), "zero minter");
        minter = newMinter;
    }

    function mint(address to) external returns (uint256 tokenId) {
        require(msg.sender == minter, "only minter");
        tokenId = nextTokenId++;
        _safeMint(to, tokenId);
    }

    function burn(uint256 tokenId) external {
        require(msg.sender == minter, "only minter");
        delete _tokenURIs[tokenId];
        _burn(tokenId);
    }

    function setTokenURI(uint256 tokenId, string calldata uri) external {
        require(msg.sender == minter, "only minter");
        require(_ownerOf(tokenId) != address(0), "missing token");
        _tokenURIs[tokenId] = uri;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(_ownerOf(tokenId) != address(0), "missing token");
        return _tokenURIs[tokenId];
    }
}
