import sys

from zen_byoip.cli import main, main_delete_eips

if __name__ == "__main__":
    av = sys.argv[1:]
    if av and av[0] == "delete-eips":
        main_delete_eips(av[1:])
    else:
        main(av)
