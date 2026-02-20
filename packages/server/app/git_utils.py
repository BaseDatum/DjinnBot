"""Git repository URL validation and normalization utilities."""
import re
import os
import subprocess
from urllib.parse import urlparse
from typing import Optional
from dataclasses import dataclass


def validate_git_url(url: str) -> tuple[bool, Optional[str]]:
    """
    Validate a Git repository URL.
    
    Args:
        url: URL to validate
    
    Returns:
        (is_valid, error_message)
    
    Supported formats:
        - https://github.com/user/repo.git
        - git@github.com:user/repo.git
        - github.com/user/repo (auto-converted to https)
    """
    if not url or not url.strip():
        return True, None  # Empty is valid (optional field)
    
    url = url.strip()
    
    # SSH format: git@host:path
    ssh_pattern = r'^git@[\w\.-]+:[\w\-\.\/]+$'
    if re.match(ssh_pattern, url):
        return True, None
    
    # HTTPS format
    if url.startswith('https://') or url.startswith('http://'):
        try:
            parsed = urlparse(url)
            if not parsed.netloc:
                return False, "Invalid URL format"
            return True, None
        except Exception:
            return False, "Malformed URL"
    
    # Shorthand: github.com/user/repo → https://github.com/user/repo.git
    shorthand_pattern = r'^([\w\.-]+)\/([\w\-\.]+)\/([\w\-\.]+)$'
    if re.match(shorthand_pattern, url):
        return True, None  # Will be normalized in normalize_git_url()
    
    return False, "Invalid Git URL format. Supported: https://, git@, or github.com/user/repo"


def normalize_git_url(url: Optional[str]) -> Optional[str]:
    """
    Normalize a Git URL to a standard format.
    
    Examples:
        github.com/user/repo → https://github.com/user/repo.git
        https://github.com/user/repo → https://github.com/user/repo.git
        git@github.com:user/repo.git → git@github.com:user/repo.git
    
    Args:
        url: URL to normalize
    
    Returns:
        Normalized URL or None if input is empty
    """
    if not url or not url.strip():
        return None
    
    url = url.strip()
    
    # Already SSH format
    if url.startswith('git@'):
        if not url.endswith('.git'):
            url += '.git'
        return url
    
    # Already HTTPS
    if url.startswith('https://') or url.startswith('http://'):
        if not url.endswith('.git'):
            url += '.git'
        return url
    
    # Shorthand: convert to HTTPS
    if '/' in url and not url.startswith('http'):
        if not url.endswith('.git'):
            url += '.git'
        return f'https://{url}'
    
    return url


@dataclass
class RepoInfo:
    """Information about a remote Git repository."""
    url: str
    accessible: bool
    default_branch: Optional[str] = None
    latest_commit: Optional[str] = None
    error: Optional[str] = None


def validate_repo_access(repo_url: str, timeout: int = 10) -> RepoInfo:
    """
    Validate that a Git repository is accessible.
    
    Uses `git ls-remote` to test connectivity without cloning.
    
    Args:
        repo_url: The Git repository URL
        timeout: Timeout in seconds
    
    Returns:
        RepoInfo with accessibility status and metadata
    """
    try:
        # Test connectivity with ls-remote
        result = subprocess.run(
            ["git", "ls-remote", "--symref", repo_url, "HEAD"],
            capture_output=True,
            text=True,
            timeout=timeout,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"}  # Disable auth prompts
        )
        
        if result.returncode != 0:
            error_msg = result.stderr.strip() or "Repository not accessible"
            return RepoInfo(url=repo_url, accessible=False, error=error_msg)
        
        # Parse default branch and commit
        output = result.stdout.strip()
        lines = output.split('\n')
        
        default_branch = None
        latest_commit = None
        
        for line in lines:
            if line.startswith('ref: refs/heads/'):
                # Extract default branch from symref
                default_branch = line.split('refs/heads/')[-1].split('\t')[0]
            elif '\tHEAD' in line:
                latest_commit = line.split('\t')[0]
        
        return RepoInfo(
            url=repo_url,
            accessible=True,
            default_branch=default_branch or "main",
            latest_commit=latest_commit
        )
    
    except subprocess.TimeoutExpired:
        return RepoInfo(url=repo_url, accessible=False, error="Connection timeout")
    except FileNotFoundError:
        return RepoInfo(url=repo_url, accessible=False, error="Git not installed")
    except Exception as e:
        return RepoInfo(url=repo_url, accessible=False, error=str(e))


def get_remote_branches(repo_url: str, limit: int = 10) -> list[dict[str, str]]:
    """
    Get list of branches from remote repository.
    
    Args:
        repo_url: The Git repository URL
        limit: Maximum number of branches to return
    
    Returns:
        List of {"name": str, "commit": str}
    """
    try:
        result = subprocess.run(
            ["git", "ls-remote", "--heads", repo_url],
            capture_output=True,
            text=True,
            timeout=10,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"}
        )
        
        if result.returncode != 0:
            return []
        
        branches = []
        for line in result.stdout.strip().split('\n'):
            if not line:
                continue
            parts = line.split('\t')
            if len(parts) == 2:
                commit = parts[0]
                ref = parts[1]
                branch_name = ref.replace('refs/heads/', '')
                branches.append({"name": branch_name, "commit": commit})
                if len(branches) >= limit:
                    break
        
        return branches
    
    except Exception:
        return []
